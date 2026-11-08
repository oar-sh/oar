// A turn on an OpenAI image model (`gpt-image-*`, `dall-e-*`) is no chat
// turn: no chat runtime can serve it, and one that is handed it fails ("No
// available capacity was found for the model", or a request rejected as
// invalid). Both Copilot engines therefore send it straight to the relay's
// image routes instead, and this module is the one copy of that path.
//
// With image continuity on (the default) the relay created an image operation
// when the message was sent, and `POST /api/image-operations/:id/execute` does
// everything: the provider call with its one retry, the generated-image reply,
// and on a failure the failure note. The caller only reports the outcome.
// Without an operation the worker calls `POST /api/openai/images/generate`
// (the same request, the same retry) and publishes the reply or the note
// itself. Neither path requeues a row whose request may have reached OpenAI:
// a second run is billed again.

export const DIRECT_IMAGE_OUTCOMES = Object.freeze(['completed', 'executing', 'terminal', 'uncertain', 'retryable']);

// The code of the error thrown when the direct request failed: the relay
// already retried what could pass, so the turn fails with the relay's note
// instead of being requeued. `imageCode` carries the relay's own code.
export const OPENAI_IMAGE_TERMINAL_CODE = 'RELAY_OPENAI_IMAGE_TERMINAL';

export function shouldUseDirectOpenAIImageApi(message = {}) {
  const providerType = String(message?.providerType || '').trim().toLowerCase();
  if (providerType !== 'openai') return false;
  const model = String(message?.providerModel || message?.model || '').trim().toLowerCase();
  return model.startsWith('gpt-image-') || model.startsWith('dall-e-');
}

export function isOpenAIImageTerminalError(error) {
  return String(error?.code || '').trim() === OPENAI_IMAGE_TERMINAL_CODE;
}

const isAutoModel = (value) => String(value || '').trim().toLowerCase() === 'auto';

function imageTerminalError(message, { imageCode = '', status, detail = null, relayProcessing = false } = {}) {
  const error = new Error(message);
  error.code = OPENAI_IMAGE_TERMINAL_CODE;
  error.imageCode = String(imageCode || '').trim().toLowerCase().replace(/_/g, '-');
  error.relayProcessing = relayProcessing;
  error.status = status;
  error.detail = detail;
  return error;
}

/**
 * The image options of a direct request: the message's `imageOptions`
 * ({ size, quality, count, output_format, background }) first, then the
 * composer's quality and size fields.
 */
function directImageOptions(message = {}) {
  const options = message?.imageOptions && typeof message.imageOptions === 'object' ? message.imageOptions : {};
  const pick = (...values) => values.find((value) => value !== undefined && value !== null && String(value).trim() !== '');
  return {
    n: pick(options.count, message?.n),
    size: pick(options.size, message?.size, message?.contextTier),
    quality: pick(options.quality, message?.quality, message?.reasoningEffort),
    output_format: pick(options.output_format),
    background: pick(options.background),
  };
}

/**
 * Run one image turn. `requestOptions` goes to every `api` call that may wait
 * on the provider (a worker passes `{ longCall: true }`: an edit with its
 * retry can take minutes); `responseFields` is merged into the reply the
 * worker publishes itself (the attempt fence).
 *
 * Resolves `{ via: 'operation', outcome, usage }` or `{ via: 'direct',
 * outcome: 'completed', imageCount, model, usage }`. On the direct path every
 * failure, once the request may have gone out, throws an error with `code`
 * `OPENAI_IMAGE_TERMINAL_CODE` and the relay's note as its message: the
 * caller publishes it and never requeues. A plain error comes only from the
 * operation path (the relay's execute route guards a second run itself).
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
      // The route answers a failure it already published with 409 (503 on
      // an older relay that requeued it) and the outcome in the body.
      if (error?.status === 409 || error?.status === 503) {
        return error?.body || error?.payload || { outcome: error?.status === 503 ? 'retryable' : 'terminal' };
      }
      throw error;
    });
    const outcome = String(result?.outcome || '').trim().toLowerCase();
    if (!DIRECT_IMAGE_OUTCOMES.includes(outcome)) {
      throw new Error('Image operation returned an invalid outcome');
    }
    return { via: 'operation', outcome, usage: result?.usage || null };
  }

  const requestedModel = isAutoModel(message?.model) ? '' : String(message?.model || '').trim();
  const directModel = String(message?.providerModel || requestedModel || message?.model || '').trim();
  const prompt = String(message?.text || '').trim();
  // Nothing was sent: a note, not a requeue that fails the same way.
  if (!directModel) throw imageTerminalError('OpenAI image request is missing model', { imageCode: 'image-request-invalid' });
  if (!prompt) throw imageTerminalError('OpenAI image request is missing prompt', { imageCode: 'image-request-invalid' });
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
      ...directImageOptions(message),
      attachments: Array.isArray(message?.attachments) ? message.attachments : [],
    }, requestOptions);
  } catch (error) {
    // The relay answered with its note (it retried what could pass), or the
    // call to the relay itself broke off while OpenAI may have been working.
    // `relayProcessing`: the provider answered 2xx and the relay could not
    // process the reply; the generation is billed.
    const relayProcessing = error?.body?.relayProcessing === true;
    const note = String(error?.body?.error || '').trim();
    if (error?.status) {
      throw imageTerminalError(note || `OpenAI image request failed: ${error?.detail || `HTTP ${error.status}`}`, {
        imageCode: error?.body?.code || (relayProcessing ? 'image-reply-unprocessed' : 'image-provider-rejected'),
        status: error.status,
        // The relay's detail (a network error's code), not its note again.
        detail: error?.body?.detail || null,
        relayProcessing,
      });
    }
    throw imageTerminalError(
      `The relay did not finish the image request (${error?.message || 'connection error'}); the request may have been billed; retry the message.`,
      { imageCode: 'image-provider-no-answer', detail: error?.message || null },
    );
  }
  const generatedImages = Array.isArray(directResult?.generatedImages) ? directResult.generatedImages : [];
  if (!generatedImages.length) {
    throw imageTerminalError('OpenAI image API returned no images. The generation may have been billed; the message was not retried.', {
      imageCode: 'image-reply-unprocessed',
      relayProcessing: true,
    });
  }
  const model = String(directResult?.model || directModel).trim() || directModel;
  const usage = directResult?.usage || null;
  // The relay's note when the first try may have been billed as well.
  const note = String(directResult?.note || '').trim();
  try {
    await api('POST', '/api/response', {
      messageId: message.id,
      conversationId: message.conversationId,
      text: '',
      generatedImages,
      model,
      modelOrigin: isAutoModel(message?.model) ? 'auto' : 'manual',
      // What OpenAI counted for this request, for the cost booking.
      ...(usage ? { imageUsage: usage } : {}),
      ...(note ? { imageNote: note } : {}),
      ...responseFields,
    });
  } catch (error) {
    // The images are billed; a requeue would pay for them again.
    throw imageTerminalError(
      `The images OpenAI returned could not be saved (${error?.detail || error?.message || 'unknown error'}). The generation was billed; the message was not retried.`,
      { imageCode: 'image-finalization-uncertain', status: error?.status, detail: error?.detail || null, relayProcessing: true },
    );
  }
  return { via: 'direct', outcome: 'completed', imageCount: generatedImages.length, model, usage };
}
