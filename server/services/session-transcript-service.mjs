'use strict';

import {
  formatStoreMemoryActivity,
  formatToolResultActivity,
  parseToolPayload,
  formatVoteMemoryActivity,
} from '../../shared/tool-activity.mjs';

export function createSessionTranscriptService({ fs, path, resolveSessionStateRoot }) {
  const TRANSCRIPT_CACHE_MAX = 128;
  const transcriptCache = new Map();

  function cacheTranscript(sessionId, record) {
    transcriptCache.set(sessionId, record);
    if (transcriptCache.size <= TRANSCRIPT_CACHE_MAX) return;
    let oldestKey = null;
    let oldestAt = Number.POSITIVE_INFINITY;
    for (const [key, value] of transcriptCache.entries()) {
      const at = Number(value?.cachedAt || 0);
      if (at < oldestAt) {
        oldestAt = at;
        oldestKey = key;
      }
    }
    if (oldestKey) transcriptCache.delete(oldestKey);
  }

  function sliceMessages(messages, options = {}) {
    const limit = Math.max(1, Number(options.limit) || 300);
    const beforeId = String(options.before || options.beforeMessageId || '').trim();
    const totalCount = Array.isArray(messages) ? messages.length : 0;
    const safeMessages = Array.isArray(messages) ? messages : [];

    let startIndex = Math.max(0, safeMessages.length - limit);
    let endIndex = safeMessages.length;
    if (beforeId) {
      const beforeIndex = safeMessages.findIndex((message) => String(message?.id || '').trim() === beforeId);
      if (beforeIndex >= 0) {
        endIndex = beforeIndex;
        startIndex = Math.max(0, endIndex - limit);
      }
    }

    const windowMessages = safeMessages.slice(startIndex, endIndex);
    return {
      messages: windowMessages,
      hasMoreHistory: startIndex > 0,
      historyCursor: String(windowMessages[0]?.id || '').trim() || null,
      newestMessageId: String(windowMessages[windowMessages.length - 1]?.id || '').trim() || null,
      totalCount,
    };
  }

  function appendTurnActivity(map, turnId, text) {
    const key = String(turnId || '').trim();
    const value = String(text || '').trim();
    if (!key || !value) return;
    const list = map.get(key) || [];
    if (list[list.length - 1] === value) {
      map.set(key, list);
      return;
    }
    list.push(value);
    map.set(key, list);
  }

  function appendTurnThought(map, turnId, thought) {
    const key = String(turnId || '').trim();
    const text = String(thought?.text || '').trim();
    if (!key || !text) return;
    const list = map.get(key) || [];
    if (list.some((entry) => entry.text === text)) return;
    list.push({
      reasoningId: `session-thought-${list.length + 1}`,
      text,
      done: true,
      timestamp: String(thought?.timestamp || '').trim() || null,
    });
    map.set(key, list);
  }

  function parseApplyPatchTarget(rawPatch) {
    const patch = String(rawPatch || '');
    if (!patch) return '';
    const match =
      patch.match(/^\*\*\* Update File:\s+(.+)$/m)
      || patch.match(/^\*\*\* Add File:\s+(.+)$/m)
      || patch.match(/^\*\*\* Delete File:\s+(.+)$/m)
      || patch.match(/^\*\*\* Move to:\s+(.+)$/m);
    if (!match) return '';
    return String(match[1] || '').trim();
  }

  function stripSystemReminderBlocks(text) {
    const value = String(text || '');
    if (!value) return '';
    return value
      .replace(/<system_reminder>[\s\S]*?<\/system_reminder>/gi, '')
      .replace(/<current_datetime>[\s\S]*?<\/current_datetime>/gi, '')
      .replace(/\[Attached file references\][\s\S]*?\[\/Attached file references\]/gi, '')
      .replace(/\[Attached image(?:s)?\s*:[\s\S]*?\]/gi, '')
      .replace(/\[Attached file\s*:[\s\S]*?\]/gi, '')
      .trim();
  }

  function collectEventTextSegments(value, out = [], { omitSystemReminders = false } = {}) {
    if (value === null || value === undefined) return out;
    if (typeof value === 'string') {
      const text = value.trim();
      if (text) out.push(text);
      return out;
    }
    if (Array.isArray(value)) {
      for (const item of value) collectEventTextSegments(item, out, { omitSystemReminders });
      return out;
    }
    if (typeof value !== 'object') return out;

    const type = String(value?.type || value?.kind || '').trim().toLowerCase();
    if (
      omitSystemReminders
      && ['system_reminder', 'system-reminder', 'system', 'system_message', 'system-message'].includes(type)
    ) {
      return out;
    }

    collectEventTextSegments(value.text, out, { omitSystemReminders });
    collectEventTextSegments(value.content, out, { omitSystemReminders });
    collectEventTextSegments(value.input_text, out, { omitSystemReminders });
    collectEventTextSegments(value.inputText, out, { omitSystemReminders });
    collectEventTextSegments(value.output_text, out, { omitSystemReminders });
    collectEventTextSegments(value.outputText, out, { omitSystemReminders });
    collectEventTextSegments(value.message, out, { omitSystemReminders });
    collectEventTextSegments(value.summary, out, { omitSystemReminders });
    collectEventTextSegments(value.result, out, { omitSystemReminders });
    collectEventTextSegments(value.response, out, { omitSystemReminders });
    collectEventTextSegments(value.output, out, { omitSystemReminders });
    collectEventTextSegments(value.answer, out, { omitSystemReminders });
    return out;
  }

  function normalizeEventContentText(value, { omitSystemReminders = false } = {}) {
    const segments = collectEventTextSegments(value, [], { omitSystemReminders });
    if (!segments.length) {
      const fallback = String(value || '').trim();
      return omitSystemReminders ? stripSystemReminderBlocks(fallback) : fallback;
    }
    const joined = segments.join('\n').trim();
    return omitSystemReminders ? stripSystemReminderBlocks(joined) : joined;
  }

  function summarizeToolDetail(toolName, args, result) {
    const name = String(toolName || '').trim();
    if (!name) return '';
    const parsedArgs = parseToolPayload(args);
    const a = parsedArgs && typeof parsedArgs === 'object' ? parsedArgs : null;
    const r = result && typeof result === 'object' ? result : null;
    const lowerName = name.toLowerCase();

    if (name === 'apply_patch') {
      if (typeof args === 'string') {
        const target = parseApplyPatchTarget(args);
        if (target) return target;
      }

      const content = String(r?.content || '').trim();
      const modified = content.match(/Modified\s+\d+\s+file\(s\):\s+(.+)$/m);
      if (modified) return String(modified[1] || '').trim();
      return '';
    }

    if (name === 'view') return String(a?.path || '').trim();
    if (name === 'powershell') return String(a?.description || a?.command || '').trim();
    if (name === 'rg') return String(a?.pattern || '').trim();
    if (name === 'glob') return String(a?.pattern || '').trim();
    if (name === 'sql') return String(a?.description || '').trim();
    if (name === 'ask_user') return String(a?.question || '').trim();
    if (name === 'report_intent') return String(a?.intent || '').trim();
    if (lowerName.includes('web_fetch') || lowerName.includes('web fetch')) {
      return String(a?.url || '').trim();
    }
    if (lowerName.includes('web_search') || lowerName.includes('web search')) {
      return String(a?.query || a?.prompt || '').trim();
    }
    if (name === 'task') return String(a?.description || '').trim();
    return '';
  }

  function parseSessionEventsToMessages(events = []) {
    const messages = [];
    const toolNameByCallId = new Map();
    const toolArgsByCallId = new Map();
    const turnActivities = new Map();
    const turnThoughts = new Map();
    const sourceEvents = Array.isArray(events) ? events : [];
    for (const event of sourceEvents) {
      const data = event?.data && typeof event.data === 'object' ? event.data : null;
      if (!data) continue;
      const timestamp = String(event?.timestamp || '').trim() || new Date().toISOString();

      if (event.type === 'session.model_change') {
        const turnId = String(data.turnId || '').trim();
        const model = String(data.newModel || data.model || '').trim();
        if (turnId && model) {
          appendTurnActivity(turnActivities, turnId, `Model selected: ${model}`);
        }
        continue;
      }

      if (event.type === 'tool.execution_start') {
        const toolCallId = String(data.toolCallId || '').trim();
        const toolName = String(data.toolName || '').trim();
        if (toolCallId && toolName) {
          toolNameByCallId.set(toolCallId, toolName);
          if (data.arguments !== undefined) {
            toolArgsByCallId.set(toolCallId, data.arguments);
          }
        }
        continue;
      }

      if (event.type === 'tool.execution_complete') {
        const turnId = String(data.turnId || '').trim();
        const toolCallId = String(data.toolCallId || '').trim();
        const toolName = String(toolNameByCallId.get(toolCallId) || data.toolName || '').trim();
        if (!turnId || !toolName || toolName === 'report_intent') continue;
        const detail = summarizeToolDetail(toolName, toolArgsByCallId.get(toolCallId), data.result);
        const toolArgs = toolArgsByCallId.get(toolCallId);
        if (toolName.toLowerCase().includes('store_memory')) {
          appendTurnActivity(turnActivities, turnId, formatStoreMemoryActivity(toolName, toolArgs));
        } else if (toolName.toLowerCase().includes('vote_memory')) {
          appendTurnActivity(turnActivities, turnId, formatVoteMemoryActivity(toolName, toolArgs));
        } else {
          appendTurnActivity(turnActivities, turnId, detail ? `Tool (${toolName}): ${detail}` : `Tool (${toolName})`);
        }
        const resultActivity = formatToolResultActivity(toolName, data.result);
        if (resultActivity) appendTurnActivity(turnActivities, turnId, resultActivity);
        continue;
      }

      if (event.type === 'user.message') {
        const text = normalizeEventContentText(data.content, { omitSystemReminders: true });
        if (!text) continue;
        const attachments = (Array.isArray(data.attachments) ? data.attachments : [])
          .map((attachment) => {
            if (!attachment || typeof attachment !== 'object') return null;
            const name = String(attachment.displayName || attachment.name || '').trim();
            const type = String(attachment.mimeType || attachment.type || '').trim().toLowerCase();
            const assetId = String(attachment.assetId || '').trim();
            const size = Number(attachment.byteLength || attachment.size || 0);
            if (!name && !type && !assetId) return null;
            return {
              name,
              type,
              size: Number.isFinite(size) && size >= 0 ? size : 0,
              sdkAssetId: assetId || undefined,
            };
          })
          .filter(Boolean);
        messages.push({
          id: String(event?.id || data?.interactionId || `user-${messages.length + 1}`),
          role: 'user',
          text,
          attachments,
          timestamp,
        });
        continue;
      }

      if (event.type === 'assistant.message') {
        const text = normalizeEventContentText(data.content);
        if (!text) continue;
        const toolRequests = Array.isArray(data.toolRequests) ? data.toolRequests : [];
        const turnId = String(data.turnId || '').trim();
        if (toolRequests.length > 0) {
          // Tool-request messages are intermediate reasoning sections. Preserve their full
          // markdown text as thoughts so history refresh does not flatten or truncate them.
          appendTurnThought(turnThoughts, turnId, { text, timestamp });
          continue;
        }
        const activities = turnId ? (turnActivities.get(turnId) || []) : [];
        const thoughts = turnId ? (turnThoughts.get(turnId) || []) : [];
        messages.push({
          id: String(data.messageId || event?.id || `assistant-${messages.length + 1}`),
          role: 'assistant',
          text,
          model: String(data.model || '').trim() || undefined,
          activities,
          thoughts,
          timestamp,
        });
      }
    }
    return messages;
  }

  function toFiniteNumber(value) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
  }

  function parseSessionUsageSummaryFromEvents(events = []) {
    const sourceEvents = Array.isArray(events) ? events : [];
    let latest = null;
    for (const event of sourceEvents) {
      if (String(event?.type || '').trim() !== 'session.shutdown') continue;
      const data = event?.data && typeof event.data === 'object' ? event.data : null;
      if (!data) continue;
      latest = { event, data };
    }
    if (!latest) return null;
    const shutdownAt = String(latest.event?.timestamp || '').trim() || null;
    const totalNanoAiu = toFiniteNumber(latest.data?.totalNanoAiu);
    const totalPremiumRequests = toFiniteNumber(latest.data?.totalPremiumRequests);
    const totalApiDurationMs = toFiniteNumber(latest.data?.totalApiDurationMs);
    const requestCount = toFiniteNumber(latest.data?.modelMetrics && typeof latest.data.modelMetrics === 'object'
      ? Object.values(latest.data.modelMetrics).reduce((sum, metric) => {
        const count = toFiniteNumber(metric?.requests?.count);
        return sum + Number(count || 0);
      }, 0)
      : null);
    const aicUsed = totalNanoAiu != null ? (totalNanoAiu / 1_000_000_000) : null;
    return {
      shutdownAt,
      totalNanoAiu,
      aicUsed,
      totalPremiumRequests,
      totalApiDurationMs,
      requestCount,
    };
  }

  function readSessionTranscriptMessages(sessionId, options = {}) {
    const sid = String(sessionId || '').trim();
    if (!sid) return [];
    const root = resolveSessionStateRoot();
    const eventsPath = path.join(root, sid, 'events.jsonl');
    if (!fs.existsSync(eventsPath)) return [];
    let stat = null;
    try {
      stat = fs.statSync(eventsPath);
    } catch {
      return [];
    }

    const mtimeMs = Number(stat?.mtimeMs || 0);
    const sizeBytes = Number(stat?.size || 0);
    const cached = transcriptCache.get(sid);
    if (cached && cached.mtimeMs === mtimeMs && cached.sizeBytes === sizeBytes) {
      cached.cachedAt = Date.now();
      const windowed = sliceMessages(cached.messages, options);
      return options.withMeta === true ? windowed : windowed.messages;
    }

    let content = '';
    try {
      content = fs.readFileSync(eventsPath, 'utf8');
    } catch {
      return [];
    }

    const events = [];
    const lines = String(content || '').split(/\r?\n/).filter(Boolean);
    for (const line of lines) {
      let event = null;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      events.push(event);
    }
    const messages = parseSessionEventsToMessages(events);
    const usageSummary = parseSessionUsageSummaryFromEvents(events);

    cacheTranscript(sid, {
      mtimeMs,
      sizeBytes,
      cachedAt: Date.now(),
      messages,
      usageSummary,
    });
    const windowed = sliceMessages(messages, options);
    return options.withMeta === true ? windowed : windowed.messages;
  }

  function readSessionUsageSummary(sessionId) {
    const sid = String(sessionId || '').trim();
    if (!sid) return null;
    const root = resolveSessionStateRoot();
    const eventsPath = path.join(root, sid, 'events.jsonl');
    if (!fs.existsSync(eventsPath)) return null;
    let stat = null;
    try {
      stat = fs.statSync(eventsPath);
    } catch {
      return null;
    }

    const mtimeMs = Number(stat?.mtimeMs || 0);
    const sizeBytes = Number(stat?.size || 0);
    const cached = transcriptCache.get(sid);
    if (cached && cached.mtimeMs === mtimeMs && cached.sizeBytes === sizeBytes) {
      cached.cachedAt = Date.now();
      return cached.usageSummary || null;
    }

    // Reuse transcript read path to refresh cache and extract summary.
    void readSessionTranscriptMessages(sid, { limit: 1 });
    return transcriptCache.get(sid)?.usageSummary || null;
  }

  return {
    parseSessionEventsToMessages,
    readSessionTranscriptMessages,
    readSessionUsageSummary,
  };
}
