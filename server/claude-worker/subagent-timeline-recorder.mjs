import crypto from 'node:crypto';
import { displayToolName, isBackgroundLaunch, isSubagentToolName } from './sdk-message-normalizer.mjs';
import {
  SUBAGENT_TIMELINE_ENTRY_MAX_CHARS,
  SUBAGENT_TIMELINE_MAX_ENTRIES,
  cutSubagentTimelineText,
  normalizeSubagentRunStatus,
} from '../../shared/subagent-timeline.mjs';

const MAX_TRACKED_RUNS = 200;

export function toolResultText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return content === null || content === undefined ? '' : String(content);
  return content.map((part) => {
    if (typeof part === 'string') return part;
    if (part?.type === 'text') return String(part.text || '');
    if (part?.type === 'image') return '[image]';
    return part?.type ? `[${part.type}]` : '';
  }).filter(Boolean).join('\n');
}

function stringifyInput(input) {
  if (input === undefined || input === null) return '';
  if (typeof input === 'string') return input;
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return String(input);
  }
}

function capText(text) {
  const value = String(text ?? '');
  return value.length > SUBAGENT_TIMELINE_ENTRY_MAX_CHARS ? value.slice(0, SUBAGENT_TIMELINE_ENTRY_MAX_CHARS) : value;
}

/**
 * Records every sub-agent's frames as its timeline — thoughts, reply text,
 * tool calls with their full input, tool results (cut at 4 KB), child agents
 * and its end — and posts them to the relay keyed by the run, not by a turn.
 *
 * It runs at process level, before any turn is resolved: a background agent
 * keeps working after the turn that spawned it ends, and its frames arrive
 * between turns (where no turn takes them) or during a later turn (whose
 * lanes they do not belong to). The relay files every entry under the run's
 * own turn.
 *
 * Writes are coalesced: an open thought or reply text is updated in place
 * (same key) and a batch goes out at most every `flushIntervalMs` per run. A
 * run the relay does not know yet (its spawn has not landed, 404) keeps its
 * entries and is retried, up to `retryLimitMs`.
 *
 * It also answers which turn owns a run's live lanes (`ownsRun`): only the
 * turn that spawned an agent shows its frames in its in-turn lanes.
 */
export function createSubagentTimelineRecorder({
  api,
  conversationId,
  dbg = () => {},
  flushIntervalMs = 500,
  retryLimitMs = 120_000,
  now = () => Date.now(),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  writerId = crypto.randomBytes(4).toString('hex'),
} = {}) {
  const runs = new Map(); // runId -> run state, in registration order
  let flushTimer = null;
  let flushing = null;
  let localCounter = 0;

  function newKey() {
    localCounter += 1;
    return `${writerId}:${localCounter}`;
  }

  function ensureRun(runId, { parentId = null, displayName = '', subagentType = '' } = {}) {
    const id = String(runId || '').trim();
    if (!id) return null;
    let run = runs.get(id);
    if (!run) {
      const parent = parentId ? runs.get(parentId) : null;
      run = {
        id,
        parentId: parentId || null,
        owner: parent?.owner || null,
        entryCount: 0,
        truncated: false,
        settled: false,
        background: false,
        pending: new Map(), // key -> entry (latest snapshot to send)
        header: { timelineOwner: 'worker' },
        headerDirty: true,
        introduced: false,
        model: '',
        streamBlocks: new Map(), // block index -> entry, for the current API message
        currentMessageId: '',
        streamed: new Map(), // API message id -> { thought: [entry], text: [entry], used: { thought, text } }
        firstFailureAt: 0,
        dropped: false,
      };
      if (parentId) run.header.parentSubagentId = parentId;
      if (displayName) run.header.displayName = displayName;
      if (subagentType) run.header.subagentType = subagentType;
      runs.set(id, run);
      evictSettledRuns();
    } else {
      if (displayName && !run.header.displayName && !run.introduced) run.header.displayName = displayName;
      if (parentId && !run.parentId) {
        run.parentId = parentId;
        run.header.parentSubagentId = parentId;
        run.owner = run.owner || runs.get(parentId)?.owner || null;
      }
    }
    return run;
  }

  function evictSettledRuns() {
    if (runs.size <= MAX_TRACKED_RUNS) return;
    for (const [id, run] of runs) {
      if (runs.size <= MAX_TRACKED_RUNS) break;
      if (run.settled && !run.pending.size && !run.headerDirty) runs.delete(id);
    }
  }

  function patchHeader(run, patch) {
    let changed = false;
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined || value === null || value === '') continue;
      if (run.header[key] === value && !run.headerDirty) continue;
      if (run.lastSentHeader?.[key] === value) continue;
      run.header[key] = value;
      changed = true;
    }
    if (changed) {
      run.headerDirty = true;
      schedule();
    }
  }

  // A new entry, unless the run is full: then one note says so, once.
  function addEntry(run, entry) {
    if (run.dropped) return null;
    if (run.entryCount >= SUBAGENT_TIMELINE_MAX_ENTRIES) {
      if (!run.truncated) {
        run.truncated = true;
        const note = { key: newKey(), kind: 'note', text: `The record stops here: a sub-agent keeps at most ${SUBAGENT_TIMELINE_MAX_ENTRIES} entries.`, done: true, metadata: { truncated: true } };
        run.pending.set(note.key, note);
        patchHeader(run, { truncated: true });
      }
      return null;
    }
    run.entryCount += 1;
    const stored = { key: newKey(), done: true, ...entry };
    run.pending.set(stored.key, stored);
    schedule();
    return stored;
  }

  // An entry already sent changes (more streamed text, its end): send its
  // newest state again under the same key.
  function touchEntry(run, entry) {
    if (!entry || run.dropped) return;
    run.pending.set(entry.key, entry);
    schedule();
  }

  function streamedFor(run, messageId) {
    const key = messageId || '';
    let slot = run.streamed.get(key);
    if (!slot) {
      slot = { thought: [], text: [], used: { thought: 0, text: 0 } };
      run.streamed.set(key, slot);
      // Only the last few API messages can still be paired.
      while (run.streamed.size > 8) run.streamed.delete(run.streamed.keys().next().value);
    }
    return slot;
  }

  // The complete copy of a thinking or text block: it replaces the streamed
  // entry of the same block (paired in block order per API message), or is
  // a new entry when nothing streamed.
  function completeBlock(run, messageId, kind, text) {
    // The streamed copy is filed under the id its message_start carried; a
    // stream without one is filed under the current (or no) id.
    const slot = [messageId, run.currentMessageId, '']
      .filter((id, index, list) => list.indexOf(id) === index)
      .map((id) => run.streamed.get(id || ''))
      .find((candidate) => candidate && candidate.used[kind] < candidate[kind].length) || null;
    if (slot) {
      const entry = slot[kind][slot.used[kind]];
      slot.used[kind] += 1;
      if (text.trim()) entry.text = capText(text);
      entry.done = true;
      touchEntry(run, entry);
      return;
    }
    if (!text.trim()) return;
    addEntry(run, { kind, text: capText(text), done: true });
  }

  function registerSpawn(block, parentId) {
    const childId = String(block?.id || '').trim();
    if (!childId) return null;
    const input = block?.input && typeof block.input === 'object' ? block.input : {};
    const displayName = String(input.description || input.name || input.subagent_type || 'Subagent').trim() || 'Subagent';
    const subagentType = String(input.subagent_type || '').trim();
    const child = ensureRun(childId, { parentId, displayName, subagentType });
    if (parentId) {
      const parent = ensureRun(parentId);
      addEntry(parent, {
        kind: 'child',
        toolUseId: childId,
        toolName: displayToolName(block?.name) || 'Agent',
        text: displayName,
        metadata: { subagentType: subagentType || null, prompt: typeof input.prompt === 'string' ? input.prompt.slice(0, 2000) : null },
      });
    }
    return child;
  }

  function observeAssistant(sdkMessage) {
    const parentId = String(sdkMessage?.parent_tool_use_id || '').trim();
    const content = Array.isArray(sdkMessage?.message?.content) ? sdkMessage.message.content : [];
    if (!parentId) {
      // The main thread: only the agents it spawns matter here.
      for (const block of content) {
        if (block?.type === 'tool_use' && isSubagentToolName(block.name)) registerSpawn(block, null);
      }
      return;
    }
    const run = ensureRun(parentId);
    const model = String(sdkMessage?.message?.model || '').trim();
    if (model && model !== '<synthetic>' && model !== run.model) {
      run.model = model;
      patchHeader(run, { model });
    }
    const messageId = String(sdkMessage?.message?.id || '').trim();
    for (const block of content) {
      const type = String(block?.type || '');
      if (type === 'thinking') {
        completeBlock(run, messageId, 'thought', String(block.thinking || ''));
      } else if (type === 'redacted_thinking') {
        completeBlock(run, messageId, 'thought', String(block.data || '').trim() ? '[Reasoning redacted by the model provider]' : '');
      } else if (type === 'text') {
        completeBlock(run, messageId, 'text', String(block.text || ''));
      } else if (type === 'tool_use') {
        if (isSubagentToolName(block.name)) {
          registerSpawn(block, parentId);
        } else {
          addEntry(run, {
            kind: 'tool_call',
            toolName: displayToolName(block.name) || 'tool',
            toolUseId: String(block.id || '').trim() || null,
            text: capText(stringifyInput(block.input)),
          });
        }
      }
    }
  }

  function observeStreamEvent(sdkMessage) {
    const parentId = String(sdkMessage?.parent_tool_use_id || '').trim();
    if (!parentId) return;
    const run = ensureRun(parentId);
    const event = sdkMessage?.event || {};
    const type = String(event.type || '');
    if (type === 'message_start') {
      run.currentMessageId = String(event?.message?.id || '').trim();
      run.streamBlocks.clear();
      return;
    }
    const index = Number(event?.index ?? 0);
    if (type === 'content_block_start') {
      const blockType = String(event?.content_block?.type || '');
      const kind = blockType === 'thinking' || blockType === 'redacted_thinking' ? 'thought' : (blockType === 'text' ? 'text' : '');
      if (!kind) return;
      const entry = addEntry(run, { kind, text: '', done: false });
      if (!entry) return;
      run.streamBlocks.set(index, entry);
      streamedFor(run, run.currentMessageId)[kind].push(entry);
      return;
    }
    if (type === 'content_block_delta') {
      const entry = run.streamBlocks.get(index);
      if (!entry || entry.done) return;
      const deltaType = String(event?.delta?.type || '');
      const piece = deltaType === 'thinking_delta' ? event.delta.thinking : (deltaType === 'text_delta' ? event.delta.text : '');
      if (!piece) return;
      entry.text = capText(entry.text + String(piece));
      touchEntry(run, entry);
      return;
    }
    if (type === 'content_block_stop') {
      const entry = run.streamBlocks.get(index);
      run.streamBlocks.delete(index);
      if (entry && !entry.done) {
        entry.done = true;
        touchEntry(run, entry);
      }
    }
  }

  function settleRun(run, status, extraHeader = {}) {
    if (!run) return;
    run.settled = status !== 'running';
    patchHeader(run, { status, ...extraHeader });
  }

  function observeUser(sdkMessage) {
    const parentId = String(sdkMessage?.parent_tool_use_id || '').trim();
    const content = Array.isArray(sdkMessage?.message?.content) ? sdkMessage.message.content : [];
    for (const block of content) {
      if (block?.type !== 'tool_result') continue;
      const toolUseId = String(block.tool_use_id || '').trim();
      // The result of a spawn: a foreground agent's end, or the receipt of a
      // background launch (whose end comes as a task notification).
      const spawned = toolUseId ? runs.get(toolUseId) : null;
      if (spawned && (spawned.parentId || '') === parentId) {
        if (block.is_error !== true && isBackgroundLaunch(block, sdkMessage?.tool_use_result || null)) {
          spawned.background = true;
          patchHeader(spawned, { background: true });
        } else if (!spawned.background) {
          settleRun(spawned, block.is_error === true ? 'failed' : 'completed');
        }
        if (parentId) continue;
      }
      if (!parentId) continue;
      const run = ensureRun(parentId);
      const full = toolResultText(block.content);
      const { text, cut } = cutSubagentTimelineText('tool_result', full);
      addEntry(run, {
        kind: 'tool_result',
        toolUseId: toolUseId || null,
        text,
        metadata: {
          ...(block.is_error === true ? { isError: true } : {}),
          ...(cut !== null ? { cut } : {}),
        },
      });
    }
  }

  function observeTaskEvent(sdkMessage) {
    const subtype = String(sdkMessage?.subtype || '');
    const toolUseId = String(sdkMessage?.tool_use_id || '').trim();
    if (!toolUseId) return;
    if (subtype === 'task_started') {
      const run = ensureRun(toolUseId, { subagentType: String(sdkMessage.subagent_type || '').trim() });
      if (sdkMessage.is_backgrounded === true) run.background = true;
      patchHeader(run, {
        taskId: String(sdkMessage.task_id || '').trim() || null,
        subagentType: String(sdkMessage.subagent_type || '').trim() || null,
        background: sdkMessage.is_backgrounded === true ? true : null,
      });
      return;
    }
    const run = runs.get(toolUseId);
    if (!run) return;
    if (subtype === 'task_updated') {
      if (sdkMessage?.patch?.is_backgrounded === true) {
        run.background = true;
        patchHeader(run, { background: true });
      }
      return;
    }
    const totalTokens = Number(sdkMessage?.usage?.total_tokens);
    if (subtype === 'task_progress') {
      if (Number.isFinite(totalTokens)) patchHeader(run, { totalTokens });
      return;
    }
    if (subtype === 'task_notification') {
      const status = normalizeSubagentRunStatus(sdkMessage.status);
      const summary = String(sdkMessage.summary || '').trim();
      const label = status === 'completed' ? 'Finished' : (status === 'failed' ? 'Failed' : 'Stopped');
      const reason = String(sdkMessage.reason || '').trim();
      addEntry(run, {
        kind: 'note',
        text: summary ? `${label}: ${summary}` : label,
        metadata: { status, ...(reason ? { reason } : {}) },
      });
      settleRun(run, status, Number.isFinite(totalTokens) ? { totalTokens } : {});
    }
  }

  /** Every SDK message the process reads, before any turn takes it. */
  function observe(sdkMessage) {
    if (!sdkMessage || typeof sdkMessage !== 'object') return;
    try {
      const type = String(sdkMessage.type || '');
      if (type === 'assistant') observeAssistant(sdkMessage);
      else if (type === 'stream_event') observeStreamEvent(sdkMessage);
      else if (type === 'user') observeUser(sdkMessage);
      else if (type === 'system') observeTaskEvent(sdkMessage);
    } catch (error) {
      dbg('subagent timeline: frame not recorded', error?.message || String(error));
    }
  }

  /**
   * The turn a top-level spawn happened in owns that agent's live lanes (and
   * its children's). Called once the frame's turn is known.
   */
  function claimSpawns(sdkMessage, owner) {
    if (!owner || sdkMessage?.type !== 'assistant' || sdkMessage?.parent_tool_use_id) return;
    const content = Array.isArray(sdkMessage?.message?.content) ? sdkMessage.message.content : [];
    for (const block of content) {
      if (block?.type !== 'tool_use' || !isSubagentToolName(block.name)) continue;
      const run = runs.get(String(block.id || '').trim());
      if (run && !run.owner) run.owner = owner;
    }
  }

  function ownsRun(runId, owner) {
    const run = runs.get(String(runId || '').trim());
    if (!run || !owner) return false;
    if (!run.owner && run.parentId) run.owner = runs.get(run.parentId)?.owner || null;
    return run.owner === owner;
  }

  /**
   * True when a frame of this run must stay out of `owner`'s live lanes: the
   * run (or an ancestor) is a background agent spawned by another turn. A
   * foreground agent belongs to the CLI turn in progress, whatever relay turn
   * carries it now; an unknown run keeps the old behaviour.
   */
  function isForeignRun(runId, owner) {
    let run = runs.get(String(runId || '').trim());
    if (!run) return false;
    const spawnOwner = run.owner || null;
    let background = false;
    for (let depth = 0; run && depth < 32; depth += 1) {
      if (run.background) background = true;
      if (!run.parentId) break;
      run = runs.get(run.parentId);
    }
    const rootOwner = spawnOwner || run?.owner || null;
    return background && !!rootOwner && rootOwner !== owner;
  }

  function schedule(delayMs = flushIntervalMs) {
    if (flushTimer) return;
    flushTimer = setTimer(() => {
      flushTimer = null;
      void flush();
    }, delayMs);
    flushTimer?.unref?.();
  }

  async function postRun(run) {
    const entries = [...run.pending.values()].map((entry) => ({
      key: entry.key,
      kind: entry.kind,
      text: entry.text,
      done: entry.done !== false,
      ...(entry.toolName ? { toolName: entry.toolName } : {}),
      ...(entry.toolUseId ? { toolUseId: entry.toolUseId } : {}),
      ...(entry.metadata && Object.keys(entry.metadata).length ? { metadata: entry.metadata } : {}),
    }));
    const header = run.headerDirty ? { ...run.header } : null;
    if (!entries.length && !header) return 'idle';
    // Taken now: entries that change while the post is in flight are sent
    // again by the next flush.
    const sentEntries = new Map([...run.pending.entries()].map(([key, entry]) => [key, { ...entry }]));
    run.pending.clear();
    run.headerDirty = false;
    try {
      await api('POST', '/api/subagent-timeline', {
        conversationId,
        subagentRunId: run.id,
        entries,
        ...(header ? { header } : {}),
      });
      run.introduced = true;
      run.lastSentHeader = { ...(run.lastSentHeader || {}), ...(header || {}) };
      run.firstFailureAt = 0;
      return 'sent';
    } catch (error) {
      const status = Number(error?.status) || 0;
      const retryable = status === 0 || status === 404 || status === 429 || status >= 500;
      if (retryable) {
        if (!run.firstFailureAt) run.firstFailureAt = now();
        if (now() - run.firstFailureAt < retryLimitMs) {
          // Put the batch back AHEAD of anything newer: the relay orders a
          // run's entries by the first time it sees each key. An entry that
          // changed meanwhile goes back in its newer state.
          const merged = new Map();
          for (const [key, entry] of sentEntries) merged.set(key, run.pending.get(key) || entry);
          for (const [key, entry] of run.pending) if (!merged.has(key)) merged.set(key, entry);
          run.pending = merged;
          if (header) run.headerDirty = true;
          return 'retry';
        }
      }
      dbg('subagent timeline: batch dropped', run.id, error?.message || String(error));
      run.firstFailureAt = 0;
      if (status === 404) run.dropped = true;
      return 'dropped';
    }
  }

  /** Send every run's pending entries and header; one flush at a time. */
  async function flush() {
    if (flushing) {
      await flushing;
      if (!flushTimer && hasPending()) schedule();
      return;
    }
    flushing = (async () => {
      let retry = false;
      // Registration order: a parent's first post (which may create the run
      // on the relay) goes before its children's.
      for (const run of [...runs.values()]) {
        if (!run.pending.size && !run.headerDirty) continue;
        const outcome = await postRun(run);
        if (outcome === 'retry') retry = true;
      }
      evictSettledRuns();
      return retry;
    })();
    try {
      const retry = await flushing;
      flushing = null;
      if (hasPending()) schedule(retry ? Math.max(flushIntervalMs, 2_000) : flushIntervalMs);
    } finally {
      flushing = null;
    }
  }

  function hasPending() {
    for (const run of runs.values()) if (run.pending.size || run.headerDirty) return true;
    return false;
  }

  /**
   * The CLI process ended: what streamed is closed, and agents still running
   * end with it (a background agent cannot outlive its process). Flushed now.
   */
  async function processEnded(reasonText = 'The Claude process ended before this agent finished.') {
    for (const run of runs.values()) {
      for (const entry of run.streamBlocks.values()) {
        if (!entry.done) {
          entry.done = true;
          touchEntry(run, entry);
        }
      }
      run.streamBlocks.clear();
      if (!run.settled && run.introduced) {
        addEntry(run, { kind: 'note', text: reasonText, metadata: { status: 'failed', reason: 'process_ended' } });
        settleRun(run, 'failed');
      }
    }
    if (flushTimer) {
      clearTimer(flushTimer);
      flushTimer = null;
    }
    await flush();
  }

  return {
    observe,
    claimSpawns,
    ownsRun,
    isForeignRun,
    flush,
    processEnded,
    hasPending,
    // For tests and diagnostics.
    runState: (runId) => runs.get(String(runId || '').trim()) || null,
  };
}
