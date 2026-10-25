// A turn on an OpenAI image model (`gpt-image-*`, `dall-e-*`) is no chat
// turn: no chat runtime can serve it, and one that is handed it fails ("No
// available capacity was found for the model", or a request rejected as
// invalid). Both Copilot engines therefore send it straight to the relay's
// image routes instead, and this module is the one copy of that path.
//
// With image continuity on (the default) the relay created an image operation
// when the message was sent, and `POST /api/image-operations/:id/execute` does
// everything: the provider call, the generated-image reply, and on a failure
// the failure note or the requeue. The caller only reports the outcome. Without
// an operation the worker calls `POST /api/openai/images/generate` and
// publishes the reply itself.

export const DIRECT_IMAGE_OUTCOMES = Object.freeze(['completed', 'executing', 'terminal', 'uncertain', 'retryable']);

// The code of the error thrown when the provider refused the request outright:
// a retry would be refused the same way, so the turn fails instead of being
// requeued.
export const OPENAI_IMAGE_TERMINAL_CODE = 'RELAY_OPENAI_IMAGE_TERMINAL';

export function shouldUseDirectOpenAIImageApi(message = {}) {
  const providerType = String(message?.providerType || '').trim().toLowerCase();
  if (providerType !== 'openai') return false;
  const model = String(message?.providerModel || message?.model || '').trim().toLowerCase();
  return model.startsWith('gpt-image-') || model.startsWith('dall-e-');
}

export function isDirectOpenAIImageTerminalStatus(status) {
  const numeric = Number(status);
  if (!Number.isFinite(numeric)) return false;
  return [400, 401, 403, 404, 409, 422, 429, 503].includes(numeric);
}

export function isOpenAIImageTerminalError(error) {
  return String(error?.code || '').trim() === OPENAI_IMAGE_TERMINAL_CODE;
}

const isAutoModel = (value) => String(value || '').trim().toLowerCase() === 'auto';

/**
 * Run one image turn. `requestOptions` goes to every `api` call that may wait
 * on the provider (a worker passes `{ longCall: true }`: an edit can take
 * minutes); `responseFields` is merged into the reply the worker publishes
 * itself (the attempt fence).
 *
 * Resolves `{ via: 'operation', outcome }` or `{ via: 'direct', outcome:
 * 'completed', imageCount, model }`. Throws an error with `code`
 * `OPENAI_IMAGE_TERMINAL_CODE` when the provider refused the direct request,
 * and a plain error for anything else (the caller requeues).
 */
export async function runDirectOpenAIImageTurn({
  api,
  message,
  requestOptions = {},
  responseFields = {},
} = {}) {
  if (message?.imageOperationId) {
    const result = await api(
      'POST',
      `/api/image-operations/${encodeURIComponent(message.imageOperationId)}/execute`,
      { messageId: message.id },
      requestOptions,
    ).catch((error) => {
      // The route answers a failure it already handled (published or
      // requeued) with 409 or 503 and the outcome in the body.
      if (error?.status === 409 || error?.status === 503) {
        return error?.body || error?.payload || { outcome: error?.status === 503 ? 'retryable' : 'terminal' };
      }
      throw error;
    });
    const outcome = String(result?.outcome || '').trim().toLowerCase();
    if (!DIRECT_IMAGE_OUTCOMES.includes(outcome)) {
      throw new Error('Image operation returned an invalid outcome');
    }
    return { via: 'operation', outcome };
  }

  const requestedModel = isAutoModel(message?.model) ? '' : String(message?.model || '').trim();
  const directModel = String(message?.providerModel || requestedModel || message?.model || '').trim();
  const prompt = String(message?.text || '').trim();
  if (!directModel) throw new Error('OpenAI image request is missing model');
  if (!prompt) throw new Error('OpenAI image request is missing prompt');
  await api('POST', '/api/activity', {
    messageId: message.id,
    conversationId: message.conversationId,
    mode: message.relayMode || 'agent',
    text: `Calling OpenAI image API directly (${directModel})`,
  }).catch(() => {});
  let directResult;
  try {
    directResult = await api('POST', '/api/openai/images/generate', {
      messageId: message.id,
      conversationId: message.conversationId,
      model: directModel,
      prompt,
      n: message?.n,
      size: message?.size || message?.contextTier,
      quality: message?.quality || message?.reasoningEffort,
      attachments: Array.isArray(message?.attachments) ? message.attachments : [],
    }, requestOptions);
  } catch (error) {
    if (isDirectOpenAIImageTerminalStatus(error?.status)) {
      const terminalError = new Error(
        `OpenAI image request failed: ${error?.detail || `HTTP ${error?.status || 'error'}`}`,
      );
      terminalError.code = OPENAI_IMAGE_TERMINAL_CODE;
      terminalError.status = error?.status;
      terminalError.detail = error?.detail || null;
      throw terminalError;
    }
    throw error;
  }
  const generatedImages = Array.isArray(directResult?.generatedImages) ? directResult.generatedImages : [];
  if (!generatedImages.length) {
    throw new Error('OpenAI image API returned no images');
  }
  const model = String(directResult?.model || directModel).trim() || directModel;
  await api('POST', '/api/response', {
    messageId: message.id,
    conversationId: message.conversationId,
    text: '',
    generatedImages,
    model,
    modelOrigin: isAutoModel(message?.model) ? 'auto' : 'manual',
    ...responseFields,
  });
  return { via: 'direct', outcome: 'completed', imageCount: generatedImages.length, model };
}
