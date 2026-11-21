/**
 * Thin adapter around the Grok CLI ACP surface. One long-lived agent process
 * per worker; sessions are created/loaded and prompts streamed via AcpClient.
 */
import { AcpClient, extractGrokModelsFromInitialize, pickAllowOnceOptionId } from './acp-client.mjs';
import { createAcpHostServices } from './acp-host-services.mjs';
import { createSdkMessageNormalizer } from './sdk-message-normalizer.mjs';
import { describeTurnStall, isTurnStalledError } from '../../shared/worker-runtime/turn-liveness.mjs';
import { WORKING_DIRECTORY_MISSING_CODE, isWorkingDirectoryMissingError } from '../../shared/worker-runtime/working-directory.mjs';
import { OAR_MCP_SERVER_NAME } from '../mcp/oar-mcp-server.mjs';

export { extractGrokModelsFromInitialize };

// How long the first prompt of a fresh or loaded session waits for OAR's MCP
// server to be connected with its tools listed. The CLI connects MCP servers
// in the background after the session has opened; a prompt sent before then
// tells the model the server is still connecting, and its first relay-tool
// call fails. The prompt goes out when the time is up either way (the CLI's
// own startup timeout is 30 s).
export const OAR_MCP_READY_TIMEOUT_MS = 10_000;

export function classifyGrokError(error) {
  const message = String(error?.message || error || '').trim();
  const lower = message.toLowerCase();
  // First, and above all before the ENOENT branch: a spawn in a folder that
  // is gone fails with ENOENT too, and the runner puts it down to the folder,
  // whose path may hold any of the words matched below.
  if (isWorkingDirectoryMissingError(error)) {
    return {
      code: `grok.${WORKING_DIRECTORY_MISSING_CODE}`,
      message,
      text: message,
      guidance: error.guidance,
      isAuth: false,
      isBusy: false,
    };
  }
  // No bare 'auth' token: it would match unrelated words ("author…") in
  // arbitrary agent error text and misclassify them as login failures.
  if (
    lower.includes('authentication')
    || lower.includes('not logged in')
    || lower.includes('not authenticated')
    || lower.includes('unauthorized')
    || lower.includes('api key')
  ) {
    return {
      code: 'grok.authentication_failed',
      // Points at the relay's own UI, which renders a Sign in button for this
      // stable code (relay-error-ctas.mjs); the host-shell advice stays as the
      // fallback for anyone reading this outside a browser.
      message: 'Grok authentication failed. Sign in from Settings → Providers → Grok, '
        + 'or run `grok login` on the relay host / set XAI_API_KEY.',
      isAuth: true,
      isBusy: false,
    };
  }
  if (lower.includes('already has an active') || lower.includes('busy')) {
    return {
      code: 'grok.agent_busy',
      message: message || 'Grok agent is busy',
      isAuth: false,
      isBusy: true,
    };
  }
  // Watchdog trips from AcpClient.sessionPrompt (inactivity or turn ceiling).
  if (lower.includes('turn stalled') || lower.includes('turn exceeded')) {
    return {
      code: 'grok.turn-stalled',
      message: message || 'Grok turn stalled',
      // The inactivity trip in the user's terms: how long, and what the agent
      // was doing. The ceiling's own message already is.
      ...(isTurnStalledError(error) ? { text: describeTurnStall(error) } : {}),
      isAuth: false,
      isBusy: false,
      isStalled: true,
    };
  }
  if (lower.includes('enoent') || lower.includes('not found') || lower.includes('spawn')) {
    return {
      code: 'grok.cli_missing',
      // The dead end this plan exists for: the only fix used to be a shell on
      // the host. The relay now installs it, and this stable code renders an
      // Install button (relay-error-ctas.mjs).
      message: 'Grok CLI was not found on PATH. Install it from Settings → Providers → Grok.',
      isAuth: false,
      isBusy: false,
    };
  }
  return {
    code: 'grok.turn-error',
    message: message || 'Grok turn failed',
    isAuth: false,
    isBusy: false,
  };
}

/**
 * Create or resume a Grok ACP session handle for one conversation worker.
 */
export async function createGrokAgentHandle({
  command = 'grok',
  args = ['agent', '--no-leader', 'stdio'],
  cwd = process.cwd(),
  env = process.env,
  alwaysApprove = true,
  nativeSessionId = '',
  model = '',
  AcpClientImpl = AcpClient,
  createHostServicesImpl = createAcpHostServices,
  // Told about every terminal (the worker's background-tasks publisher).
  taskObserver = null,
  // The MCP server the first prompt waits for (only when the session carries
  // one by that name; other servers the host configured are never waited
  // for), and for how long at most; 0 turns the wait off.
  mcpReadyServerName = OAR_MCP_SERVER_NAME,
  mcpReadyTimeoutMs = OAR_MCP_READY_TIMEOUT_MS,
  dbg = () => {},
} = {}) {
  const client = new AcpClientImpl({
    command,
    args,
    cwd,
    env,
    alwaysApprove,
  });

  // Without any 'error' listener, a spawn failure (ENOENT when the Grok CLI
  // is not installed) would make the emitter throw ERR_UNHANDLED_ERROR and
  // crash the process. The pending-request rejection already surfaces the
  // failure to the awaiting caller, so the listener only needs to exist.
  client.on('error', () => {});

  client.on('stderr', (text) => {
    const line = String(text || '').trim();
    if (line) dbg('grok stderr', line.slice(0, 400));
  });

  // The terminal/fs handlers backing the capabilities initialize() advertises.
  // They must be attached before the first prompt, or the agent's first shell
  // command deadlocks the turn waiting on terminal/create.
  const hostServices = createHostServicesImpl({ cwd, env, dbg, ...(taskObserver ? { taskObserver } : {}) });
  hostServices.attach(client);

  await client.initialize();
  const discovered = extractGrokModelsFromInitialize(client.initializeResult);

  let sessionId = '';
  let resumeFailed = false;
  const resumeId = String(nativeSessionId || '').trim();
  if (resumeId) {
    // Attempting session/load against an agent that never advertised the
    // capability is a guaranteed failure; either way a fresh session is a
    // silent history loss the caller must be able to surface.
    const capabilities = client.initializeResult?.agentCapabilities
      || client.initializeResult?.capabilities
      || {};
    const supportsLoad = capabilities.loadSession === true || capabilities.load_session === true;
    if (!supportsLoad) {
      resumeFailed = true;
      dbg('grok agent does not advertise loadSession; starting fresh');
    } else {
      try {
        const loaded = await client.sessionLoad(resumeId, cwd);
        sessionId = String(loaded?.sessionId || loaded?.session_id || resumeId).trim();
      } catch (error) {
        resumeFailed = true;
        dbg('grok session/load failed, creating new session', error?.message || String(error));
      }
    }
  }
  if (!sessionId) {
    const extra = {};
    const modelId = String(model || '').trim();
    if (modelId) {
      // Best-effort: some Grok builds accept model via _meta on session/new.
      extra._meta = { modelId };
    }
    const created = await client.sessionNew(cwd, extra);
    sessionId = String(created?.sessionId || created?.session_id || '').trim();
  }
  if (!sessionId) {
    hostServices.disposeAll();
    await client.dispose();
    throw new Error('Grok session/new did not return sessionId');
  }

  // Asked by every prompt; prompts wait until one wait has ended (ready,
  // failed, timeout or closed), later ones go out at once. A turn cancelled
  // meanwhile only stops listening: the wait goes on, and the next prompt
  // joins it instead of skipping it.
  const readyServer = String(mcpReadyServerName || '').trim();
  const readyTimeoutMs = Number(mcpReadyTimeoutMs) > 0 ? Number(mcpReadyTimeoutMs) : 0;
  let mcpReadyDone = false;
  let mcpReadyWait = null;
  const waitForReadyServer = async () => {
    const servers = Array.isArray(client.mcpServers) ? client.mcpServers : [];
    if (!readyServer || !readyTimeoutMs || typeof client.waitForMcpServer !== 'function') return null;
    if (!servers.some((server) => String(server?.name || '').trim() === readyServer)) return null;
    const result = await client.waitForMcpServer(sessionId, readyServer, { timeoutMs: readyTimeoutMs });
    if (result.status === 'timeout') {
      dbg('grok mcp server not ready in time; prompting anyway', `${readyServer} after ${result.waitedMs}ms`);
    } else {
      dbg('grok mcp server wait', `${readyServer} ${result.status}${result.reason ? ` (${result.reason})` : ''} after ${result.waitedMs}ms`);
    }
    return { server: readyServer, ...result };
  };
  const untilMcpReady = () => {
    if (mcpReadyDone) return Promise.resolve(null);
    if (!mcpReadyWait) {
      mcpReadyWait = waitForReadyServer().catch(() => null).then((result) => {
        mcpReadyDone = true;
        mcpReadyWait = null;
        return result;
      });
    }
    return mcpReadyWait;
  };

  return {
    client,
    sessionId,
    model: String(model || discovered.defaultModel || '').trim(),
    discovered,
    hostServices,
    resumeFailed,
    untilMcpReady,
    async close() {
      hostServices.disposeAll();
      await client.dispose();
    },
  };
}

/**
 * Stream-friendly turn starter used by the turn runner. Yields the same
 * channel actions the normalizer produces, draining pending actions interleaved
 * by polling a queue that the ACP update handler fills.
 */
export function startGrokTurn({
  handle,
  text = '',
  reasoningEffort = '',
  abortSignal = null,
  watchdog = null,
  createNormalizerImpl = createSdkMessageNormalizer,
  dbg = () => {},
} = {}) {
  if (!handle?.client || !handle?.sessionId) {
    throw new Error('missing grok agent handle');
  }

  const normalizer = createNormalizerImpl();
  const queue = [];
  let done = false;
  let settleError = null;
  let resolveWait = null;

  function wake() {
    if (resolveWait) {
      const r = resolveWait;
      resolveWait = null;
      r();
    }
  }

  function enqueue(action) {
    queue.push(action);
    wake();
  }

  enqueue({
    channel: 'init',
    payload: {
      sessionId: handle.sessionId,
      model: handle.model || '',
    },
  });

  let cancelled = false;
  let endReadyWait = () => {};
  const readyWaitEnded = new Promise((resolve) => { endReadyWait = resolve; });
  const onAbort = () => {
    cancelled = true;
    endReadyWait();
    try {
      handle.client.sessionCancel(handle.sessionId);
    } catch (error) {
      dbg('session/cancel failed', error?.message || String(error));
    }
  };
  if (abortSignal) {
    if (abortSignal.aborted) onAbort();
    else abortSignal.addEventListener('abort', onAbort, { once: true });
  }

  const onPermission = (msg) => {
    // Prefer a one-shot allow: a blanket "allow always" would grant more than
    // the relay's per-request approval parity intends.
    const optionId = pickAllowOnceOptionId(msg?.params?.options);
    try {
      handle.client.respond(msg.id, {
        outcome: { outcome: 'selected', optionId },
      });
    } catch (error) {
      dbg('permission respond failed', error?.message || String(error));
    }
  };
  handle.client.on('permission', onPermission);

  // Best-effort per-turn reasoning effort: forwarded on the prompt `_meta`
  // the same way the model is passed on session/new. Unknown _meta keys are
  // ignored by agent builds that do not support them.
  const effort = String(reasoningEffort || '').trim().toLowerCase();
  const promptExtra = effort && effort !== 'none'
    ? { _meta: { reasoningEffort: effort } }
    : {};

  // The first prompt of the session waits for OAR's MCP server (see
  // createGrokAgentHandle); a turn cancelled meanwhile stops listening to the
  // wait and sends no prompt. The prompt watchdog starts with the prompt, so the wait is not
  // counted against it.
  const mcpReady = typeof handle.untilMcpReady === 'function'
    ? Promise.race([
      Promise.resolve().then(() => handle.untilMcpReady()).catch(() => null),
      readyWaitEnded,
    ])
    : Promise.resolve(null);
  const promptPromise = mcpReady.then(() => {
    if (cancelled) throw new Error('turn cancelled before the prompt was sent');
    return handle.client.sessionPrompt(
      handle.sessionId,
      [{ type: 'text', text: String(text || '') }],
      (update) => {
        for (const action of normalizer.normalizeAcpUpdate(update)) {
          enqueue(action);
        }
      },
      promptExtra,
      {
        // A running client-hosted terminal (or an in-flight terminal/fs request)
        // means the agent is waiting on us, not stalled.
        hasPendingWork: () => handle.hostServices?.hasPendingWork?.() === true,
        ...(watchdog || {}),
      },
    );
  }).then((promptResult) => {
    const stopReason = String(promptResult?.stopReason || promptResult?.stop_reason || '').trim();
    const isError = stopReason.toLowerCase() === 'error' || promptResult?.isError === true;
    // Per-prompt usage lives on the result `_meta` (tokens + costUsdTicks).
    // Prefer that over any mid-stream usage_update the normalizer may have seen.
    const meta = promptResult?._meta && typeof promptResult._meta === 'object'
      ? promptResult._meta
      : null;
    const usage = meta
      ? {
        ...meta,
        usage: meta.usage,
        modelId: meta.modelId || handle.model || '',
      }
      : null;
    for (const action of normalizer.finalizeResult({
      stopReason: cancelled ? 'cancelled' : stopReason,
      text: normalizer.finalStreamText(),
      isError: cancelled ? false : isError,
      errorMessage: isError ? String(promptResult?.error || promptResult?.message || stopReason) : '',
      model: String(meta?.modelId || handle.model || '').trim(),
      usage,
    })) {
      enqueue(action);
    }
  }).catch((error) => {
    if (cancelled || abortSignal?.aborted) {
      for (const action of normalizer.finalizeResult({
        stopReason: 'cancelled',
        text: normalizer.finalStreamText(),
      })) {
        enqueue(action);
      }
      return;
    }
    settleError = error;
  }).finally(() => {
    done = true;
    wake();
    handle.client.off('permission', onPermission);
    if (abortSignal) {
      try {
        abortSignal.removeEventListener('abort', onAbort);
      } catch {
        /* ignore */
      }
    }
  });

  async function* iterator() {
    while (true) {
      while (queue.length) {
        yield queue.shift();
      }
      if (done) {
        if (settleError) throw settleError;
        return;
      }
      await new Promise((resolve) => {
        resolveWait = resolve;
      });
    }
  }

  const iter = iterator();
  iter.cancel = async () => {
    onAbort();
    await promptPromise.catch(() => {});
  };
  return iter;
}
