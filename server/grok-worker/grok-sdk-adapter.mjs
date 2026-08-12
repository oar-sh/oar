/**
 * Thin adapter around the Grok CLI ACP surface. One long-lived agent process
 * per worker; sessions are created/loaded and prompts streamed via AcpClient.
 */
import { AcpClient, extractGrokModelsFromInitialize } from './acp-client.mjs';
import { createAcpHostServices } from './acp-host-services.mjs';
import { createSdkMessageNormalizer } from './sdk-message-normalizer.mjs';

export { extractGrokModelsFromInitialize };

export function classifyGrokError(error) {
  const message = String(error?.message || error || '').trim();
  const lower = message.toLowerCase();
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
      message: 'Grok authentication failed. Run `grok login` on the relay host, or set XAI_API_KEY.',
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
      isAuth: false,
      isBusy: false,
      isStalled: true,
    };
  }
  if (lower.includes('enoent') || lower.includes('not found') || lower.includes('spawn')) {
    return {
      code: 'grok.cli_missing',
      message: 'Grok CLI was not found on PATH. Install Grok Build / Grok CLI on the relay host.',
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
  const hostServices = createHostServicesImpl({ cwd, env, dbg });
  hostServices.attach(client);

  await client.initialize();
  const discovered = extractGrokModelsFromInitialize(client.initializeResult);

  let sessionId = '';
  const resumeId = String(nativeSessionId || '').trim();
  if (resumeId) {
    try {
      const loaded = await client.sessionLoad(resumeId, cwd);
      sessionId = String(loaded?.sessionId || loaded?.session_id || resumeId).trim();
    } catch (error) {
      dbg('grok session/load failed, creating new session', error?.message || String(error));
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

  return {
    client,
    sessionId,
    model: String(model || discovered.defaultModel || '').trim(),
    discovered,
    hostServices,
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
  const onAbort = () => {
    cancelled = true;
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
    const options = Array.isArray(msg?.params?.options) ? msg.params.options : [];
    // Prefer a one-shot allow: a blanket "allow always" would grant more than
    // the relay's per-request approval parity intends.
    const allowOnce = options.find((opt) => {
      const id = String(opt?.optionId || opt?.id || '').toLowerCase();
      return id.includes('allow') && !id.includes('always') && !id.includes('reject') && !id.includes('deny');
    });
    const allowAny = options.find((opt) => {
      const id = String(opt?.optionId || opt?.id || '').toLowerCase();
      return id.includes('allow');
    });
    const optionId = String(
      allowOnce?.optionId || allowOnce?.id
      || allowAny?.optionId || allowAny?.id
      || 'allow-once',
    );
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

  const promptPromise = handle.client.sessionPrompt(
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
  ).then((promptResult) => {
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
