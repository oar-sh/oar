import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { serveFileWithRangeSupport } from '../services/file-serving.mjs';
import { stripRemotePromptHeader } from '../../shared/remote-relay-contract.mjs';
import {
  OPENAI_IMAGE_MIME_BY_FORMAT,
  openAIImageModelFamily,
  validateOpenAIImageOptions,
} from '../../shared/openai-image-options.mjs';
import { OPENAI_IMAGE_PARTIAL_IMAGES, OPENAI_IMAGE_PARTIALS_DIR } from '../../shared/openai-image-previews.mjs';
import {
  SSE_EVENT_TOO_LARGE_CODE,
  interpretOpenAIImageStreamEvent,
  isEventStreamResponse,
  readSseEvents,
} from '../services/openai-image-stream.mjs';
import { OPENAI_IMAGE_DAILY_CAP_REACHED_CODE, OPENAI_IMAGE_USAGE_PATH } from '../../shared/openai-image-spend.mjs';
import { estimateOpenAIImageCost } from '../../shared/openai-image-prices.mjs';
import {
  openAIImageCapRefusalText,
  openAIImageTryCharge,
  openAIImageTryRunId,
} from '../services/openai-image-spend-service.mjs';
import { IMAGE_HEADER_BYTES, readImageHeader } from '../../shared/image-header.mjs';
import { createLocalRequestCheck } from '../services/request-boundary.mjs';
import {
  asSentence,
  delay,
  isBase64Text,
  resolveGeneratedImageReadPath,
  splitBase64DataUrl,
} from './messages-helpers.mjs';

// The image routes of the message API: a generated image's content, the
// partial previews of a running image turn, today's image spend, and the
// OpenAI image request of an image turn (the execute route of an image
// operation, and the generate route for a row without one).

// How long one OpenAI image request may take, from sending it to the last
// byte of the reply; config.json `openaiImageGenerateTimeoutMs` and
// `openaiImageEditTimeoutMs` override them. Above 300 s undici's own header
// timeout ends a request first.
export const OPENAI_IMAGE_GENERATE_TIMEOUT_MS = 180_000;
export const OPENAI_IMAGE_EDIT_TIMEOUT_MS = 300_000;
// The pause before the one retry of a request that may pass the second time.
const OPENAI_IMAGE_RETRY_DELAY_MS = 2_000;
// OpenAI takes up to 16 input images on an edit.
const OPENAI_IMAGE_EDIT_INPUTS_MAX = 16;

function parseOpenAIImageBase64Value(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (!isBase64Text(raw)) {
    throw new Error('OpenAI image payload contains invalid base64 data');
  }
  return Buffer.from(raw, 'base64').toString('base64');
}

/**
 * The body of one image request (the generate route's, or the one the
 * execute route builds from an operation), checked against the model's
 * family. `n` is the count; size and quality "auto" pass and are left out
 * for a dall-e model when the request is built. A prompt that came from an
 * agent on another relay loses its "[Remote prompt from …]" header: OpenAI
 * would draw it.
 */
export function normalizeOpenAIImageGenerateRequestBody(rawBody) {
  const body = rawBody && typeof rawBody === 'object' ? rawBody : {};
  const messageId = String(body.messageId || '').trim();
  const conversationId = String(body.conversationId || '').trim();
  const model = String(body.model || '').trim();
  const prompt = stripRemotePromptHeader(String(body.prompt || '')).trim();
  if (!messageId) throw new Error('Missing messageId');
  if (!conversationId) throw new Error('Missing conversationId');
  if (!model) throw new Error('Missing model');
  if (!prompt) throw new Error('Missing prompt');

  const legacySize = String(body.size ?? '').trim().toLowerCase();
  const checked = validateOpenAIImageOptions({
    size: legacySize === 'default' || legacySize === 'long_context' ? 'auto' : body.size,
    quality: body.quality,
    count: body.n,
    output_format: body.output_format,
    background: body.background,
  }, { model, field: 'image' });
  if (!checked.ok) throw new Error(checked.error);

  const attachments = body.attachments;
  if (attachments !== undefined && !Array.isArray(attachments)) {
    throw new Error('attachments must be an array when provided');
  }

  return {
    messageId,
    conversationId,
    model,
    prompt,
    n: checked.values.count,
    size: checked.values.size,
    quality: checked.values.quality,
    output_format: checked.values.output_format,
    background: checked.values.background,
    attachments: Array.isArray(attachments) ? attachments : [],
  };
}

/**
 * The fields OpenAI gets for one image request. dall-e models take no
 * output_format or background, and their "auto" size or quality is not sent
 * (the API's own default); they answer in b64_json only when asked to.
 */
export function buildOpenAIImageRequestFields(requestBody = {}) {
  const family = openAIImageModelFamily(requestBody.model);
  const isGptImage = family === 'gpt-image';
  const fields = { model: requestBody.model, prompt: requestBody.prompt };
  if (!isGptImage) fields.response_format = 'b64_json';
  if (requestBody.n !== undefined) fields.n = requestBody.n;
  for (const key of ['size', 'quality']) {
    const value = requestBody[key];
    if (value && (isGptImage || value !== 'auto')) fields[key] = value;
  }
  if (isGptImage) {
    if (requestBody.output_format) fields.output_format = requestBody.output_format;
    if (requestBody.background) fields.background = requestBody.background;
  }
  return fields;
}

const OPENAI_IMAGE_USAGE_DETAIL_KEYS = Object.freeze(['input_tokens_details', 'output_tokens_details']);

/**
 * The `usage` block of an OpenAI image reply, numbers only (top level and
 * the two token-detail blocks), or null when there is none.
 */
export function normalizeOpenAIImageUsage(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const numbersOf = (source) => {
    const out = {};
    for (const [key, value] of Object.entries(source || {})) {
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0) out[key] = value;
    }
    return out;
  };
  const usage = numbersOf(raw);
  for (const key of OPENAI_IMAGE_USAGE_DETAIL_KEYS) {
    const detail = raw[key];
    if (detail && typeof detail === 'object' && !Array.isArray(detail)) {
      const numbers = numbersOf(detail);
      if (Object.keys(numbers).length) usage[key] = numbers;
    }
  }
  return Object.keys(usage).length ? usage : null;
}

/**
 * Two image usages added up, field by field and detail by detail (a stream
 * of a count > 1 request reports one per completed image); null + null is
 * null.
 */
export function addOpenAIImageUsage(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  const sum = { ...a };
  for (const [key, value] of Object.entries(b)) {
    if (typeof value === 'number') sum[key] = (typeof sum[key] === 'number' ? sum[key] : 0) + value;
    else if (value && typeof value === 'object') sum[key] = addOpenAIImageUsage(sum[key] && typeof sum[key] === 'object' ? sum[key] : null, value);
  }
  return sum;
}

// The base64 characters that decode to the first IMAGE_HEADER_BYTES bytes.
const IMAGE_HEADER_BASE64_CHARS = Math.ceil(IMAGE_HEADER_BYTES / 3) * 4;

/** readImageHeader of a canonical base64 payload, decoding only its start. */
function readBase64ImageHeader(base64) {
  const text = String(base64 || '');
  if (!text) return null;
  return readImageHeader(Buffer.from(text.slice(0, IMAGE_HEADER_BASE64_CHARS), 'base64'));
}

// What one OpenAI image request came to, as `kind`:
// - 'unsent': it never reached OpenAI (no connection, no name, no TLS);
//   nothing was billed.
// - 'timeout', 'broken', 'server': no answer in time, the connection broke
//   off after the request may have gone out, or a 5xx; it may have been
//   billed.
// - 'stream': a streamed reply that broke off, or ended without its image,
//   after OpenAI had started on it; it may have been billed.
// - 'refused': a 4xx (429 included); nothing came of it, a retry is refused
//   the same way.
// - 'unprocessed': a 2xx the relay could not read; billed.
// The first five are tried once more; the last two never.
const OPENAI_IMAGE_RETRY_KINDS = new Set(['unsent', 'timeout', 'broken', 'server', 'stream']);
const OPENAI_IMAGE_AMBIGUOUS_KINDS = new Set(['timeout', 'broken', 'server', 'stream']);
const OPENAI_IMAGE_UNSENT_ERROR_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT']);
const OPENAI_IMAGE_TIMEOUT_ERROR_CODES = new Set(['UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT']);

export const OPENAI_IMAGE_INTERRUPTED_NOTE = 'The relay was interrupted while OpenAI was working on the image; the request may have been billed; retry the message.';
export const OPENAI_IMAGE_REPEATED_NOTE = 'This image request was already sent to OpenAI once and was not sent again; the first request may have been billed; retry the message.';
// The guidance under every image failure note: the note itself says what to do.
const OPENAI_IMAGE_FAILURE_GUIDANCE = 'If this keeps failing, include the error code when you report it.';

/** The `code` of a thrown fetch error and of every cause under it. */
function fetchErrorCodes(error) {
  const codes = [];
  const seen = new Set();
  const visit = (entry, depth) => {
    if (!entry || typeof entry !== 'object' || seen.has(entry) || depth > 4) return;
    seen.add(entry);
    if (entry.code) codes.push(String(entry.code));
    visit(entry.cause, depth + 1);
    if (Array.isArray(entry.errors)) for (const inner of entry.errors) visit(inner, depth + 1);
  };
  visit(error, 0);
  return codes;
}

function isTlsFailureCode(code) {
  return code.startsWith('ERR_TLS_') || code.startsWith('ERR_SSL_') || code.includes('CERT') || code === 'EPROTO';
}

/** 'unsent', 'timeout' or 'broken' for an error fetch threw (see OPENAI_IMAGE_RETRY_KINDS). */
export function classifyOpenAIImageFetchError(error) {
  if (error?.name === 'TimeoutError' || error?.cause?.name === 'TimeoutError') return 'timeout';
  const codes = fetchErrorCodes(error);
  if (codes.some((code) => OPENAI_IMAGE_TIMEOUT_ERROR_CODES.has(code))) return 'timeout';
  if (codes.length && codes.every((code) => OPENAI_IMAGE_UNSENT_ERROR_CODES.has(code) || isTlsFailureCode(code))) return 'unsent';
  return 'broken';
}

function describeFetchError(error) {
  const codes = [...new Set(fetchErrorCodes(error))];
  const message = String(error?.message || error || 'request error').trim();
  return codes.length ? `${message} (${codes.join(', ')})` : message;
}

function formatNoteDuration(ms) {
  const value = Math.max(0, Number(ms) || 0);
  return value >= 1000 ? `${Math.round(value / 1000)} s` : `${Math.round(value)} ms`;
}

/**
 * The failure of an image request after its tries: the note the chat shows
 * (`error`), the attempt's code, `outcome` 'uncertain' when it may have been
 * billed (else 'terminal'), and the HTTP status the generate route answers.
 * A request that never reached OpenAI on its last try but may have been
 * billed on the first is told as the first.
 */
export function openAIImageFailureResult(tries, { timeoutMs = 0, resent = false } = {}) {
  const list = Array.isArray(tries) && tries.length ? tries : [{ kind: 'broken' }];
  const last = list[list.length - 1];
  const ambiguous = list.find((entry) => OPENAI_IMAGE_AMBIGUOUS_KINDS.has(entry.kind)) || null;
  const deciding = last.kind === 'unsent' && ambiguous ? ambiguous : last;
  // A resend without stream fields is the second request of a turn whose
  // first was refused for them before any work.
  const triedText = resent ? 'sent twice, once without previews' : (list.length > 1 ? 'tried twice' : 'tried once');
  const maybeBilled = 'the request may have been billed; retry the message.';
  // A refusal or an unreadable reply after a first try that may have been
  // billed: the note says so too.
  const earlierBilled = ambiguous && !OPENAI_IMAGE_AMBIGUOUS_KINDS.has(deciding.kind) && deciding.kind !== 'unsent'
    ? ' The first try may have been billed as well.'
    : '';
  const base = {
    ok: false,
    tries: list.length,
    sent: list.some((entry) => entry.kind !== 'unsent'),
    ...(deciding.detail ? { detail: String(deciding.detail).slice(0, 500) } : {}),
    upstreamStatus: Number.isFinite(Number(deciding.status)) && Number(deciding.status) > 0 ? Number(deciding.status) : null,
  };
  switch (deciding.kind) {
    case 'unsent':
      return { ...base, status: 502, outcome: 'terminal', code: 'IMAGE_PROVIDER_UNREACHABLE', error: 'OpenAI could not be reached; nothing was billed; retry the message.' };
    case 'timeout': {
      const waited = deciding.ownTimeout === false ? 'in time' : `within ${formatNoteDuration(timeoutMs)}`;
      return { ...base, status: 504, outcome: 'uncertain', code: 'IMAGE_PROVIDER_NO_ANSWER', error: `OpenAI did not answer ${waited} (${triedText}); ${maybeBilled}` };
    }
    case 'server':
      return { ...base, status: 502, outcome: 'uncertain', code: 'IMAGE_PROVIDER_UNAVAILABLE', error: `OpenAI answered ${deciding.status || 'with a server error'} (${triedText}); ${maybeBilled}` };
    case 'stream':
      return { ...base, status: 502, outcome: 'uncertain', code: 'IMAGE_STREAM_BROKEN', error: `OpenAI's image stream broke off before the image was complete (${triedText}); ${maybeBilled}` };
    case 'refused': {
      const message = String(deciding.message || '').trim().slice(0, 240);
      return {
        ...base,
        status: deciding.status >= 400 && deciding.status < 500 ? deciding.status : 502,
        outcome: 'terminal',
        code: 'IMAGE_PROVIDER_REJECTED',
        error: `${asSentence(`OpenAI refused the image request (${deciding.status})${message ? `: ${message}` : ''}`)}${earlierBilled}`,
      };
    }
    case 'unprocessed':
      return {
        ...base,
        status: 502,
        outcome: 'terminal',
        code: 'IMAGE_REPLY_UNPROCESSED',
        relayProcessing: true,
        error: `The relay could not process the image OpenAI returned (${deciding.detail || 'unknown error'}). The generation was billed; the message was not retried.${earlierBilled}`,
      };
    default:
      return { ...base, status: 502, outcome: 'uncertain', code: 'IMAGE_PROVIDER_NO_ANSWER', error: `The connection to OpenAI broke off (${triedText}); ${maybeBilled}` };
  }
}

/**
 * The note on an image request that came through on its second try after a
 * first that may have reached OpenAI (OPENAI_IMAGE_AMBIGUOUS_KINDS): both may
 * have been billed. Empty when the earlier tries never went out.
 */
export function openAIImageRetriedNote(tries, { timeoutMs = 0 } = {}) {
  const first = (Array.isArray(tries) ? tries : []).find((entry) => OPENAI_IMAGE_AMBIGUOUS_KINDS.has(entry?.kind));
  if (!first) return '';
  const tail = 'it was sent once more and the first try may have been billed as well.';
  switch (first.kind) {
    case 'timeout': {
      const waited = first.ownTimeout === false ? 'in time' : `within ${formatNoteDuration(timeoutMs)}`;
      return `OpenAI did not answer the first try ${waited}; ${tail}`;
    }
    case 'server':
      return `OpenAI answered the first try with ${first.status || 'a server error'}; ${tail}`;
    case 'stream':
      return `OpenAI's image stream broke off on the first try; ${tail}`;
    default:
      return `The connection to OpenAI broke off on the first try; ${tail}`;
  }
}

/**
 * The failure of an image request whose next try the daily cap stopped
 * before it was sent (`refusal`: the spend service's reserveTry). Nothing of
 * that try reached OpenAI; an earlier try may have been billed, and the note
 * says so then.
 */
export function openAIImageCapRefusalResult(tries, refusal = {}) {
  const list = Array.isArray(tries) ? tries : [];
  const earlierBilled = list.some((entry) => OPENAI_IMAGE_AMBIGUOUS_KINDS.has(entry?.kind));
  return {
    ok: false,
    tries: list.length,
    sent: list.some((entry) => entry?.kind !== 'unsent'),
    status: 409,
    outcome: earlierBilled ? 'uncertain' : 'terminal',
    code: OPENAI_IMAGE_DAILY_CAP_REACHED_CODE,
    error: openAIImageCapRefusalText({ tryNumber: earlierBilled ? 2 : 1, refusal }),
    upstreamStatus: null,
  };
}

// The file system the partial preview route serves through: its open
// follows no link.
const PARTIAL_PREVIEW_FS = Object.freeze({
  ...fs,
  openSync: (file) => fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)),
});

/** A request refused before anything was sent to OpenAI. */
function openAIImageRequestRefusal(status, code, error) {
  return { ok: false, tries: 0, sent: false, status, outcome: 'terminal', code, error, upstreamStatus: null };
}

/** The `terminalError` /api/response gets for a failed image request. */
function openAIImageTerminalError(result) {
  return {
    code: result.code,
    message: String(result.error || 'Image operation failed').slice(0, 500),
    ...(result.detail ? { detail: String(result.detail).slice(0, 500) } : {}),
    guidance: OPENAI_IMAGE_FAILURE_GUIDANCE,
    retryable: false,
  };
}

function isOpenAIImageAttachment(raw) {
  if (!raw || typeof raw !== 'object') return false;
  const type = String(raw.type || '').trim().toLowerCase();
  if (type.startsWith('image/')) return true;
  const dataUrl = String(raw.dataUrl || '').trim().toLowerCase();
  return dataUrl.startsWith('data:image/');
}

export function resolveOpenAIImageEditAttachment(rawAttachments, options = {}) {
  return resolveOpenAIImageEditAttachments(rawAttachments, { ...options, maxImages: 1 })[0] || null;
}

/**
 * Every image attachment of an edit, in the order given (the first is the
 * base image), at most `maxImages`; the others are ignored.
 */
export function resolveOpenAIImageEditAttachments(rawAttachments, {
  maxImages = OPENAI_IMAGE_EDIT_INPUTS_MAX,
  ...options
} = {}) {
  const attachments = Array.isArray(rawAttachments) ? rawAttachments : [];
  return attachments
    .filter((entry) => isOpenAIImageAttachment(entry))
    .slice(0, Math.max(1, Math.trunc(Number(maxImages) || 1)))
    .map((entry) => resolveOneOpenAIImageEditAttachment(entry, options));
}

function resolveOneOpenAIImageEditAttachment(image, {
  maxImageBytes = 20 * 1024 * 1024,
  allowedRootPath = '',
  // Folders of earlier versions that uploads are still read from: only a
  // sha256-named blob directly inside one counts.
  allowedBlobRootPaths = [],
  allowedGeneratedImagesRootPath = '',
} = {}) {
  const dataUrl = String(image.dataUrl || '').trim();
  let mimeType = String(image.type || '').trim().toLowerCase();
  let bytes = null;

  if (dataUrl.startsWith('data:')) {
    const parts = splitBase64DataUrl(dataUrl);
    if (!parts) throw new Error('Invalid image attachment data URL');
    mimeType = mimeType || String(parts.mimeType || '').trim().toLowerCase();
    const payload = parseOpenAIImageBase64Value(parts.payload);
    bytes = Buffer.from(payload, 'base64');
  } else {
    const filePath = String(image.path || '').trim();
    if (!filePath) throw new Error('Image attachment is missing file path or data URL');
    const allowedRoot = String(allowedRootPath || '').trim();
    const blobRoots = (Array.isArray(allowedBlobRootPaths) ? allowedBlobRootPaths : [])
      .map((root) => String(root || '').trim())
      .filter(Boolean);
    const generatedImagesRoot = String(allowedGeneratedImagesRootPath || '').trim();
    if (allowedRoot || blobRoots.length || generatedImagesRoot) {
      const resolvedPath = path.resolve(filePath);
      const isWithinRoot = (rootPath) => {
        if (!rootPath) return false;
        const resolvedRoot = path.resolve(rootPath);
        const rootPrefix = resolvedRoot.endsWith(path.sep) ? resolvedRoot : `${resolvedRoot}${path.sep}`;
        return resolvedPath === resolvedRoot || resolvedPath.startsWith(rootPrefix);
      };
      const isGeneratedImagePath = (() => {
        if (!generatedImagesRoot || !isWithinRoot(generatedImagesRoot)) return false;
        const relativeParts = path.relative(path.resolve(generatedImagesRoot), resolvedPath).split(path.sep);
        return relativeParts.length >= 3
          && relativeParts[0] !== '..'
          && relativeParts[1] === 'generated-images';
      })();
      const isOldUploadBlob = blobRoots.some((root) => (
        path.dirname(resolvedPath) === path.resolve(root)
        && /^[a-f0-9]{64}$/.test(path.basename(resolvedPath))
      ));
      if (!isWithinRoot(allowedRoot) && !isOldUploadBlob && !isGeneratedImagePath) {
        throw new Error('Image attachment path is outside the upload directory');
      }
    }
    if (!fs.existsSync(filePath)) throw new Error(`Image attachment file not found: ${filePath}`);
    bytes = fs.readFileSync(filePath);
  }

  // What the bytes are wins over what the attachment says they are.
  mimeType = (Buffer.isBuffer(bytes) && readImageHeader(bytes)?.mime) || mimeType;
  if (!mimeType.startsWith('image/')) {
    throw new Error('Image attachment must use image/* MIME type');
  }
  if (!Buffer.isBuffer(bytes) || !bytes.length) {
    throw new Error('Image attachment payload is empty');
  }
  if (bytes.length > maxImageBytes) {
    throw new Error('Image attachment is too large');
  }

  return {
    bytes,
    mimeType,
    name: String(image.name || 'image').trim().slice(0, 120) || 'image',
  };
}

/**
 * The images of an OpenAI image reply. Their type comes from the format
 * asked for (`outputFormat`), else the one the reply names, else PNG; the
 * image's own header has the last word.
 */
export function normalizeOpenAIImageApiGeneratedImages(payload, { maxImages = 8, outputFormat = '' } = {}) {
  const rows = Array.isArray(payload?.data) ? payload.data : [];
  const maxCount = Math.max(1, Math.trunc(Number(maxImages) || 8));
  const format = String(outputFormat || payload?.output_format || '').trim().toLowerCase();
  const declaredMime = OPENAI_IMAGE_MIME_BY_FORMAT[format] || OPENAI_IMAGE_MIME_BY_FORMAT.png;
  const generatedImages = [];
  for (const [index, row] of rows.entries()) {
    if (index >= maxCount) break;
    if (!row || typeof row !== 'object') continue;
    const data = parseOpenAIImageBase64Value(row.b64_json || row.data || row.base64);
    if (!data) throw new Error('OpenAI image response is missing b64_json');
    const revisedPrompt = String(row.revised_prompt || row.revisedPrompt || '').trim();
    generatedImages.push({
      data,
      mimeType: readBase64ImageHeader(data)?.mime || declaredMime,
      name: `generated-image-${index + 1}`,
      ...(revisedPrompt ? { revisedPrompt } : {}),
    });
  }
  if (!generatedImages.length) {
    throw new Error('OpenAI image response did not contain generated images');
  }
  return generatedImages;
}

export function registerGeneratedImageContentRoute(app, deps) {
  const {
    auth,
    db,
    parseAttachments,
    hydrateAttachment,
    resolveSessionStateRoot,
  } = deps;

  const getMessageAttachmentsByConversation = db.prepare(`
    SELECT attachments
    FROM messages
    WHERE id = ? AND conversation_id = ?
    LIMIT 1
  `);

  app.get('/api/generated-image/:conversationId/:messageId/:imageId/content', auth, (req, res) => {
    const conversationId = String(req.params.conversationId || '').trim();
    const messageId = String(req.params.messageId || '').trim();
    const imageId = String(req.params.imageId || '').trim();
    if (!conversationId || !messageId || !imageId) {
      return res.status(400).json({ error: 'Invalid generated image reference' });
    }
    const messageRow = getMessageAttachmentsByConversation.get(messageId, conversationId);
    if (!messageRow) return res.status(404).json({ error: 'Generated image not found' });
    const attachments = parseAttachments(messageRow.attachments).map(hydrateAttachment).filter(Boolean);
    const attachment = attachments.find((entry) => {
      const generatedImage = entry?.generatedImage && typeof entry.generatedImage === 'object'
        ? entry.generatedImage
        : null;
      return String(generatedImage?.imageId || '').trim() === imageId;
    });
    if (!attachment) return res.status(404).json({ error: 'Generated image not found' });
    const generatedImage = attachment.generatedImage;
    const filePath = resolveGeneratedImageReadPath({
      resolveSessionStateRoot,
      sessionId: generatedImage?.sessionId,
      relativePath: generatedImage?.relativePath,
    });
    if (!filePath || !fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'Generated image file missing' });
    }
    let stat = null;
    try {
      stat = fs.statSync(filePath);
    } catch {
      return res.status(404).json({ error: 'Generated image file missing' });
    }
    if (!stat.isFile()) return res.status(404).json({ error: 'Generated image file missing' });
    return serveFileWithRangeSupport(req, res, filePath, {
      size: stat.size,
      contentType: String(attachment.type || 'application/octet-stream').trim() || 'application/octet-stream',
    }, {
      safeName: path.basename(filePath).replace(/"/g, ''),
    });
  });

}

// Registers the image routes; returns imageTurnRequeueStop for /api/requeue.
// `imageSpend` and `imagePreviews` are the message routes' own instances.
export function registerMessagesImageRoutes(app, deps, { imageSpend, imagePreviews }) {
  const {
    auth,
    db,
    stmts,
    config,
    // `(conversationId) => token`: an agent token for one conversation, for
    // the relay's own call back into /api/response (an image operation).
    mintAgentToken = () => '',
    uuidv4,
    ts,
    MAX_UPLOAD_BYTES,
    MAX_UPLOAD_ATTACHMENTS,
    uploadsDir,
    uploadReadDirs = [uploadsDir],
    remotePath,
    uploadPathForSha,
    touchCli,
    parseAttachments,
    getOpenAIProviderSettings = () => ({ enabled: false, model: '' }),
    isTrulyLocalRequest = createLocalRequestCheck().isTrulyLocal,
    // The pause before the one retry of an OpenAI image request.
    openAIImageRetryDelayMs = OPENAI_IMAGE_RETRY_DELAY_MS,
    resolveSessionStateRoot,
  } = deps;

  // Image operations whose OpenAI request runs in this process, and the
  // direct image requests (no operation) this process sent, by queue
  // message: a second run of either would be billed again.
  const executingImageOperations = new Set();
  const dispatchedImageMessages = new Map();
  const DISPATCHED_IMAGE_MESSAGES_MAX = 500;
  const openAIImageTimeoutFromConfig = (key, fallback) => (Number(config?.[key]) > 0 ? Number(config[key]) : fallback);
  const openAIImageGenerateTimeoutMs = openAIImageTimeoutFromConfig('openaiImageGenerateTimeoutMs', OPENAI_IMAGE_GENERATE_TIMEOUT_MS);
  const openAIImageEditTimeoutMs = openAIImageTimeoutFromConfig('openaiImageEditTimeoutMs', OPENAI_IMAGE_EDIT_TIMEOUT_MS);

  // A partial preview of a running image turn, for the owner's clients
  // only: only a file the turn wrote and still has is served (no path is
  // built from the request), never through a share link, and gone with the
  // turn.
  app.get(`/api/generated-image/:conversationId/:messageId/${OPENAI_IMAGE_PARTIALS_DIR}/:fileName`, auth, (req, res) => {
    const file = imagePreviews.partialFile({
      conversationId: String(req.params.conversationId || '').trim(),
      messageId: String(req.params.messageId || '').trim(),
      fileName: String(req.params.fileName || '').trim(),
    });
    // lstat: a link put in the turn's partials folder is not followed.
    let stat = null;
    try {
      stat = file ? fs.lstatSync(file.path) : null;
    } catch {}
    if (!stat?.isFile()) return res.status(404).json({ error: 'Preview not found' });
    return serveFileWithRangeSupport(req, res, file.path, { size: stat.size, contentType: file.mime }, {
      safeName: path.basename(file.path).replace(/"/g, ''),
      // And the open itself refuses a link swapped in after the lstat (POSIX;
      // Windows has no O_NOFOLLOW, the lstat is the guard there).
      fsImpl: PARTIAL_PREVIEW_FS,
    });
  });

  function noteDispatchedImageMessage(messageId) {
    dispatchedImageMessages.delete(messageId);
    dispatchedImageMessages.set(messageId, { at: Date.now(), running: true });
    while (dispatchedImageMessages.size > DISPATCHED_IMAGE_MESSAGES_MAX) {
      dispatchedImageMessages.delete(dispatchedImageMessages.keys().next().value);
    }
    return dispatchedImageMessages.get(messageId);
  }

  /**
   * One try of an OpenAI image request: `{ ok: true, generatedImages, usage }`
   * or `{ kind, status?, message?, detail? }` (see OPENAI_IMAGE_RETRY_KINDS).
   * The timeout covers the reply's body as well, a streamed one whole.
   * `fields` asking for a stream get one read event by event (a reply that is
   * no event stream is read as JSON); `onPartial` sees each partial image.
   */
  async function sendOpenAIImageRequestOnce({ url, headers, fields, editImages, family, timeoutMs, outputFormat, model, onPartial = null }) {
    // The images asked for: a stream's events past them are dropped.
    const expectedImages = Math.max(1, Math.trunc(Number(fields.n) || 1));
    let response;
    try {
      let body;
      if (editImages.length) {
        body = new FormData();
        for (const [key, value] of Object.entries(fields)) body.set(key, String(value));
        // gpt-image takes every image, the first being the base; dall-e-2
        // takes one.
        const images = family === 'gpt-image' ? editImages : editImages.slice(0, 1);
        for (const image of images) {
          body.append(
            family === 'gpt-image' ? 'image[]' : 'image',
            new Blob([image.bytes], { type: image.mimeType }),
            image.name,
          );
        }
      } else {
        body = JSON.stringify(fields);
      }
      response = await fetch(url, {
        method: 'POST',
        headers: editImages.length ? headers : { ...headers, 'Content-Type': 'application/json' },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const kind = classifyOpenAIImageFetchError(error);
      return { kind, ownTimeout: error?.name === 'TimeoutError', detail: describeFetchError(error) };
    }

    const status = Number(response.status);
    if (response.ok && fields.stream === true && isEventStreamResponse(response)) {
      return readOpenAIImageStream(response, { status, outputFormat, model, onPartial, expectedImages });
    }
    let rawText = '';
    try {
      rawText = String(await response.text()).trim();
    } catch (error) {
      // A 2xx whose body broke off is billed; an error status keeps its class.
      if (response.ok) return { kind: 'unprocessed', status, detail: `the reply broke off: ${describeFetchError(error)}` };
      return status >= 500 ? { kind: 'server', status } : { kind: 'refused', status };
    }
    let payload = {};
    if (rawText) {
      try {
        payload = JSON.parse(rawText);
      } catch {
        // After a 2xx the generation is billed; a retry pays again. An error
        // status with a body that is not JSON stays a provider failure.
        if (response.ok) return { kind: 'unprocessed', status, detail: 'OpenAI image API returned invalid JSON' };
        payload = null;
      }
    }
    if (!response.ok) {
      const message = String(payload?.error?.message || payload?.message || (payload ? '' : rawText)).trim().slice(0, 240);
      if (!Number.isFinite(status) || status >= 500) return { kind: 'server', status, message };
      return { kind: 'refused', status, message };
    }
    try {
      const generatedImages = normalizeOpenAIImageApiGeneratedImages(payload, {
        maxImages: MAX_UPLOAD_ATTACHMENTS,
        outputFormat,
      });
      return { ok: true, generatedImages, usage: normalizeOpenAIImageUsage(payload?.usage) };
    } catch (error) {
      // The usage the reply carried is what was billed.
      const usage = normalizeOpenAIImageUsage(payload?.usage);
      // The provider answered 2xx, so the generation is billed; what failed
      // is the relay's handling of the reply. Logged with the stack: a retry
      // pays again and fails the same way.
      console.error(
        `[${ts()}] IMAGE     reply of ${model} not processed: ${error?.message || error} (body ${rawText.length} chars)\n${error?.stack || ''}`,
      );
      return { kind: 'unprocessed', status, detail: error?.message || 'OpenAI image API returned no images', ...(usage ? { usage } : {}) };
    }
  }

  /**
   * The rest of a streamed reply (after a 2xx with an event stream): each
   * partial goes to `onPartial`, each completed event's image is kept in
   * order (a count > 1 turn may get several), and the completed events'
   * usages add up to the request's. A stream that breaks off, ends without an image
   * or reports a server error after OpenAI started may have been billed:
   * 'stream', 'timeout' or 'server', tried once more. An error event that
   * names a refusal is 'refused'; an image the relay cannot read, or an event
   * past the reader's cap, 'unprocessed'.
   *
   * Once every image asked for (`expectedImages`) is complete, a stream that
   * breaks off or times out before its end still answers them: they are
   * billed, and a retry would buy them again. Partials past
   * OPENAI_IMAGE_PARTIAL_IMAGES per image or past the images asked for, and
   * completed events past those images, are dropped unread.
   *
   * Every result carries `partials` (received) and, once a completed event
   * was read, `usage`: a try that fails after it books that usage
   * (openAIImageTryCharge).
   */
  async function readOpenAIImageStream(response, { status, outputFormat, model, onPartial, expectedImages = 1 }) {
    const completed = [];
    let usage = null;
    let partials = 0;
    // What every result carries for the booking.
    const counted = (result) => ({ ...result, partials, ...(usage ? { usage } : {}) });
    const answer = () => {
      try {
        const generatedImages = normalizeOpenAIImageApiGeneratedImages({
          data: completed.map((payload) => ({ b64_json: payload.b64_json })),
          output_format: completed[0].output_format,
        }, { maxImages: MAX_UPLOAD_ATTACHMENTS, outputFormat });
        return counted({ ok: true, generatedImages });
      } catch (error) {
        console.error(`[${ts()}] IMAGE     streamed reply of ${model} not processed: ${error?.message || error}\n${error?.stack || ''}`);
        return counted({ kind: 'unprocessed', status, detail: error?.message || 'OpenAI image stream returned no images' });
      }
    };
    try {
      for await (const sse of readSseEvents(response.body)) {
        const event = interpretOpenAIImageStreamEvent(sse);
        if (event.type === 'partial') {
          partials += 1;
          const partialIndex = Number.isInteger(event.payload.partial_image_index) ? event.payload.partial_image_index : partials - 1;
          const shown = completed.length < expectedImages && partialIndex >= 0 && partialIndex < OPENAI_IMAGE_PARTIAL_IMAGES;
          if (onPartial && shown) {
            try {
              await onPartial({
                imageIndex: completed.length,
                partialIndex,
                b64: event.payload.b64_json,
                outputFormat: event.payload.output_format || outputFormat,
              });
            } catch (error) {
              console.warn(`[${ts()}] IMAGE     partial of ${model} not shown: ${error?.message || error}`);
            }
          }
        } else if (event.type === 'completed') {
          if (completed.length >= expectedImages) continue;
          completed.push(event.payload);
          usage = addOpenAIImageUsage(usage, normalizeOpenAIImageUsage(event.payload.usage));
        } else if (event.type === 'invalid' && sse.event.endsWith('.completed')) {
          return counted({ kind: 'unprocessed', status, detail: 'OpenAI image stream sent an unreadable image' });
        } else if (event.type === 'error') {
          const { message, type, code } = event.error;
          const named = `${type} ${code}`.toLowerCase();
          const detail = `error event in the stream${code ? ` (${code})` : ''} after ${partials} partial image(s)`;
          if (['server', 'internal', 'overloaded', 'timeout', 'unavailable'].some((word) => named.includes(word)) || !named.trim()) {
            return counted({ kind: 'server', message, detail });
          }
          return counted({ kind: 'refused', status: 400, message, detail, streamed: true });
        }
      }
    } catch (error) {
      if (error?.code === SSE_EVENT_TOO_LARGE_CODE) return counted({ kind: 'unprocessed', status, detail: error.message });
      if (completed.length >= expectedImages) {
        console.warn(`[${ts()}] IMAGE     ${model} stream broke off after its ${completed.length} image(s): kept (${describeFetchError(error)})`);
        return answer();
      }
      const kind = classifyOpenAIImageFetchError(error);
      return counted({
        kind: kind === 'timeout' ? 'timeout' : 'stream',
        ownTimeout: error?.name === 'TimeoutError',
        detail: `the stream broke off after ${partials} partial image(s): ${describeFetchError(error)}`,
      });
    }
    if (!completed.length) return counted({ kind: 'stream', detail: `the stream ended without an image after ${partials} partial image(s)` });
    return answer();
  }

  /**
   * The OpenAI image request of one turn, for the execute route and the
   * generate route alike: the request with every option and every input
   * image, a timeout per try (generate / edit), and one retry of a try that
   * may pass the second time, with the same Idempotency-Key (OpenAI may
   * ignore it; the note says the request may have been billed). Never more
   * than two requests: nothing else may send this turn again.
   *
   * `requestBody` is normalizeOpenAIImageGenerateRequestBody's. Resolves
   * `{ ok: true, generatedImages, model, endpoint, usage, tries, note? }`
   * (`note`: openAIImageRetriedNote's) or openAIImageFailureResult's failure.
   *
   * A gpt-image request is streamed with OPENAI_IMAGE_PARTIAL_IMAGES partials
   * per image (dall-e models do not stream). With `preview` ({ conversationId,
   * messageId }: the queue message the turn answers) the owner's clients see
   * each try start and each partial; a retry drops the first try's, and the
   * turn's end (/api/response) the rest.
   *
   * Each try is checked against the daily cap and reserves its estimate
   * right before it is sent (the resend without stream fields keeps the
   * reservation); the cap refuses a try with OPENAI_IMAGE_DAILY_CAP_REACHED
   * and sends nothing. When the try ends, its cost is booked under the queue
   * row (`scopeId`: the image attempt, or the claim, that runs it; run_id
   * image:<scopeId>:try<n>) and its reservation dropped, in one step.
   */
  async function runOpenAIImageRequest(requestBody, { idempotencyKey = '', preview = null, scopeId = '' } = {}) {
    const settings = getOpenAIProviderSettings();
    if (settings?.configured !== true || !String(settings?.apiKey || '').trim()) {
      return openAIImageRequestRefusal(503, 'IMAGE_PROVIDER_NOT_CONFIGURED', 'OpenAI BYOK is not configured');
    }
    const baseUrl = String(settings.baseUrl || '').trim().replace(/\/+$/, '');
    if (!baseUrl) return openAIImageRequestRefusal(503, 'IMAGE_PROVIDER_NOT_CONFIGURED', 'OpenAI base URL is not configured');

    let editImages = [];
    try {
      editImages = resolveOpenAIImageEditAttachments(requestBody.attachments, {
        maxImageBytes: MAX_UPLOAD_BYTES,
        allowedRootPath: uploadsDir,
        allowedBlobRootPaths: uploadReadDirs.slice(1),
        allowedGeneratedImagesRootPath: resolveSessionStateRoot?.() || '',
      });
    } catch (error) {
      return openAIImageRequestRefusal(400, 'IMAGE_REQUEST_INVALID', error?.message || 'Invalid image attachment');
    }

    const family = openAIImageModelFamily(requestBody.model);
    const fields = buildOpenAIImageRequestFields(requestBody);
    const endpoint = editImages.length ? '/images/edits' : '/images/generations';
    const timeoutMs = editImages.length ? openAIImageEditTimeoutMs : openAIImageGenerateTimeoutMs;
    const headers = {
      Authorization: `Bearer ${settings.apiKey}`,
      ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
    };
    let streaming = family === 'gpt-image' && OPENAI_IMAGE_PARTIAL_IMAGES > 0;
    const previewTurn = preview
      ? imagePreviews.begin({
        conversationId: preview.conversationId,
        messageId: preview.messageId,
        size: requestBody.size,
        quality: requestBody.quality,
        count: requestBody.n,
        model: requestBody.model,
      })
      : null;
    const tries = [];
    // HTTP requests of this turn, the resend without stream fields included:
    // never more than two.
    let calls = 0;
    let resent = false;
    let result = null;
    // What a try of this request costs, and where it books.
    const spendRequest = {
      model: requestBody.model,
      size: requestBody.size,
      quality: requestBody.quality,
      count: requestBody.n,
      inputImages: editImages.length,
    };
    const bookingScope = String(scopeId || '').trim() || `claim_${randomUUID()}`;
    // The try in flight's reservation: held across the resend, released
    // (with its booking, or without one) when the try ends.
    let reservation = null;
    previewTurn?.started(1);
    try {
      for (;;) {
        if (!reservation) {
          const tryNumber = tries.length + 1;
          const reserved = imageSpend.reserveTry({ estimateUsd: estimateOpenAIImageCost(spendRequest).costUsd });
          if (!reserved.ok) {
            console.warn(`[${ts()}] IMAGE     ${requestBody.model} ${endpoint} try=${tryNumber} stopped by the daily cap`);
            result = openAIImageCapRefusalResult(tries, reserved);
            break;
          }
          reservation = reserved.reservation;
        }
        calls += 1;
        const tried = await sendOpenAIImageRequestOnce({
          url: `${baseUrl}${endpoint}`,
          // The resend's body differs from the first request's: its own key.
          headers: resent && idempotencyKey ? { ...headers, 'Idempotency-Key': `${idempotencyKey}-nostream` } : headers,
          fields: streaming ? { ...fields, stream: true, partial_images: OPENAI_IMAGE_PARTIAL_IMAGES } : fields,
          editImages,
          family,
          timeoutMs,
          outputFormat: requestBody.output_format,
          model: requestBody.model,
          onPartial: previewTurn ? (partial) => previewTurn.partial(partial) : null,
        });
        // The resend without stream fields (below) is the same try: it keeps
        // the reservation and books once.
        const resend = streaming && calls < 2 && tried.kind === 'refused' && Number(tried.status) === 400 && !tried.streamed
          && /\bstream|partial_image/i.test(String(tried.message || '').slice(0, 240));
        if (!resend) {
          imageSpend.settleTry(reservation, {
            conversationId: requestBody.conversationId,
            turnId: requestBody.messageId,
            runId: openAIImageTryRunId(bookingScope, tries.length + 1),
            model: requestBody.model,
            charge: openAIImageTryCharge({ tried, request: spendRequest }),
          });
          reservation = null;
        }
        if (tried.ok) {
          const note = openAIImageRetriedNote(tries, { timeoutMs });
          result = {
            ok: true,
            generatedImages: tried.generatedImages,
            model: requestBody.model,
            endpoint,
            usage: tried.usage,
            tries: tries.length + 1,
            ...(note ? { note } : {}),
          };
          break;
        }
        // An endpoint that takes no stream (an OpenAI-compatible one, or a
        // model OpenAI does not stream) refuses the fields with a 400 before
        // any work: the same try again without them, nothing billed. It
        // counts as one of the two requests, so a resend that fails is final.
        // Any other refusal (a 429 that names streaming, say) is no reason.
        if (resend) {
          console.warn(`[${ts()}] IMAGE     ${requestBody.model} ${endpoint} refused streaming; sent again without it`);
          streaming = false;
          resent = true;
          continue;
        }
        tries.push(tried);
        console.warn(
          `[${ts()}] IMAGE     ${requestBody.model} ${endpoint} try=${tries.length} ${tried.kind}`
          + `${tried.status ? ` status=${tried.status}` : ''}${tried.detail ? ` ${String(tried.detail).slice(0, 200)}` : ''}`,
        );
        if (calls >= 2 || !OPENAI_IMAGE_RETRY_KINDS.has(tried.kind)) break;
        await delay(openAIImageRetryDelayMs);
        previewTurn?.retry();
        previewTurn?.started(tries.length + 1);
      }
    } finally {
      // A throw or an abort: the try books nothing it did not book above.
      imageSpend.releaseTry(reservation);
      previewTurn?.ended({ ok: Boolean(result?.ok) });
    }
    return result || openAIImageFailureResult(tries, { timeoutMs, resent });
  }

  // Today's OpenAI image spend against the daily cap (the Check Usage card,
  // the banner, a paired relay's check before create_session); with
  // `?conversationId=` also that chat's.
  app.get(OPENAI_IMAGE_USAGE_PATH, auth, (req, res) => {
    const conversationId = String(req.query?.conversationId || '').trim().slice(0, 200) || null;
    try {
      return res.json(imageSpend.buildState({ conversationId }));
    } catch (error) {
      return res.status(500).json({ error: `Image spend could not be read: ${error?.message || error}` });
    }
  });

  /**
   * An image attempt the recovery found cut off while its request ran
   * ('started', now 'uncertain'): it may have been billed, so its estimate
   * is booked as image:<attemptId>:recovered, unless a try of that attempt
   * was booked already.
   */
  function bookRecoveredImageAttempt(operation, attempt) {
    if (!operation || !attempt?.id) return;
    let parameters = {};
    try {
      parameters = JSON.parse(operation.parameters_json || '{}') || {};
    } catch {}
    let inputImages = operation.parent_node_id ? 1 : 0;
    if (!operation.parent_node_id) {
      try {
        inputImages = (stmts.listAssets?.all?.(operation.id) || []).length;
      } catch {}
    }
    try {
      imageSpend.bookRecovered({
        conversationId: operation.conversation_id,
        turnId: operation.queue_message_id,
        attemptId: attempt.id,
        model: operation.selected_image_model,
        startedAt: attempt.started_at,
        request: { size: parameters.size, quality: parameters.quality, count: parameters.count ?? 1, inputImages },
      });
    } catch (error) {
      console.warn(`[${ts()}] IMAGE_OP  the estimate of attempt=${attempt.id} was not booked: ${error?.message || error}`);
    }
  }

  /**
   * Why a queue row may not go back to pending (/api/requeue): `{ running:
   * true }` while its image request runs in this process, `{ failure }`
   * (a terminalError) once its request went to OpenAI, or null for a row
   * whose request was never sent (requeueing it bills nothing).
   */
  function imageTurnRequeueStop(queueRow) {
    const operationId = String(queueRow?.image_operation_id || '').trim();
    if (operationId) {
      if (executingImageOperations.has(operationId)) return { running: true };
      const attempt = stmts.getLatestAttempt?.get?.(operationId) || null;
      if (!attempt) return null;
      if (attempt.status === 'started') {
        stmts.finishAttempt.run({
          id: attempt.id,
          status: 'uncertain',
          providerRequestId: null,
          providerConversationId: null,
          providerResponseId: null,
          httpStatus: null,
          errorCode: 'IMAGE_ATTEMPT_INTERRUPTED',
          errorMessage: OPENAI_IMAGE_INTERRUPTED_NOTE,
          completedAt: new Date().toISOString(),
        });
        bookRecoveredImageAttempt(stmts.getOperation?.get?.(operationId), attempt);
        return { failure: { code: 'IMAGE_ATTEMPT_INTERRUPTED', message: OPENAI_IMAGE_INTERRUPTED_NOTE, guidance: OPENAI_IMAGE_FAILURE_GUIDANCE } };
      }
      return {
        failure: {
          code: String(attempt.error_code || '').trim() || 'IMAGE_ATTEMPT_REPEATED',
          message: String(attempt.error_message || '').trim() || OPENAI_IMAGE_REPEATED_NOTE,
          guidance: OPENAI_IMAGE_FAILURE_GUIDANCE,
        },
      };
    }
    const dispatched = dispatchedImageMessages.get(String(queueRow?.id || ''));
    if (!dispatched) return null;
    if (dispatched.running) return { running: true };
    return { failure: { code: 'IMAGE_ATTEMPT_REPEATED', message: OPENAI_IMAGE_REPEATED_NOTE, guidance: OPENAI_IMAGE_FAILURE_GUIDANCE } };
  }

  // Called by the relay's own worker on this machine; nothing that came in
  // through a proxy or the tunnel may start a provider image request.
  // The request runs in this process (runOpenAIImageRequest): its timeout
  // and its one retry are the only ones. A failure ends the row with a note,
  // never with a requeue: a requeued image turn was billed again.
  app.post('/api/image-operations/:operationId/execute', auth, async (req, res) => {
    if (!isTrulyLocalRequest(req)) {
      return res.status(403).json({ error: 'Image operation execution is reachable from this machine only' });
    }
    const operationId = String(req.params.operationId || '').trim();
    const operation = operationId ? stmts.getOperation?.get(operationId) : null;
    if (!operation) return res.status(404).json({ error: 'Image operation not found' });

    const committedNodes = stmts.listNodesForOperation?.all(operationId) || [];
    if (committedNodes.length) {
      return res.json({ ok: true, outcome: 'completed', operationId, nodeCount: committedNodes.length });
    }
    const queueRow = stmts.findQById.get(operation.queue_message_id);
    if (!queueRow || queueRow.image_operation_id !== operationId) {
      return res.status(409).json({ error: 'Image operation queue linkage is unavailable' });
    }
    // Delivered again while its request still runs here (a worker that
    // died and came back): that run finishes the row.
    if (executingImageOperations.has(operationId)) {
      return res.status(202).json({ ok: true, outcome: 'executing', operationId });
    }

    const now = new Date().toISOString();
    // The relay calls itself as that conversation's agent: an agent token
    // minted for it, never the owner token.
    const selfHeaders = {
      Authorization: `Bearer ${mintAgentToken(operation.conversation_id)}`,
      'Content-Type': 'application/json',
    };
    const selfBaseUrl = `http://127.0.0.1:${config.port}`;
    const publishFailure = async (terminalError) => {
      // `terminalError` is the field /api/response reads; under any other
      // name the failure was refused as an empty reply and the row stayed
      // processing until the relay recovered and re-ran it.
      const response = await fetch(`${selfBaseUrl}${remotePath}/api/response`, {
        method: 'POST',
        headers: selfHeaders,
        body: JSON.stringify({
          messageId: operation.queue_message_id,
          conversationId: operation.conversation_id,
          terminalError,
        }),
      }).catch(() => null);
      if (!response?.ok) {
        console.warn(`[${ts()}] IMAGE_OP  failed to publish the failure of operation=${operationId}`);
      }
    };
    const acquireAttempt = db.transaction(() => {
      const current = stmts.getLatestAttempt.get(operationId);
      if (current?.status === 'started') {
        const attemptStartedAt = Date.parse(current.started_at);
        const queueProcessingAt = Date.parse(queueRow.processing_at);
        const recoveredAfterAttempt = Number.isFinite(attemptStartedAt)
          && Number.isFinite(queueProcessingAt)
          && queueProcessingAt > attemptStartedAt + 1_000;
        if (!recoveredAfterAttempt) return { acquired: false, attempt: current };
        stmts.finishAttempt.run({
          id: current.id,
          status: 'uncertain',
          providerRequestId: null,
          providerConversationId: null,
          providerResponseId: null,
          httpStatus: null,
          errorCode: 'IMAGE_ATTEMPT_INTERRUPTED',
          errorMessage: OPENAI_IMAGE_INTERRUPTED_NOTE,
          completedAt: now,
        });
        return { acquired: false, attempt: current, stale: true };
      }
      // An attempt that ended: its note was published, or publishing it
      // failed and the row came back. Either way the request is not sent
      // again.
      if (current) return { acquired: false, attempt: current, finished: true };
      const attempt = {
        id: `img_attempt_${uuidv4()}`,
        operationId,
        attemptNumber: 1,
        provider: operation.provider,
        capabilitySnapshotJson: JSON.stringify({
          executionMode: operation.execution_mode,
          endpoint: 'images',
        }),
        startedAt: now,
      };
      stmts.insertAttempt.run(attempt);
      return { acquired: true, attempt: stmts.getLatestAttempt.get(operationId) };
    });
    const acquired = acquireAttempt();
    if (acquired.stale) {
      bookRecoveredImageAttempt(operation, acquired.attempt);
      await publishFailure({
        code: 'IMAGE_ATTEMPT_INTERRUPTED',
        message: OPENAI_IMAGE_INTERRUPTED_NOTE,
        guidance: OPENAI_IMAGE_FAILURE_GUIDANCE,
        retryable: false,
      });
      return res.status(409).json({
        ok: false,
        outcome: 'uncertain',
        operationId,
        code: 'IMAGE_ATTEMPT_INTERRUPTED',
        error: OPENAI_IMAGE_INTERRUPTED_NOTE,
      });
    }
    if (acquired.finished) {
      const earlier = acquired.attempt;
      const message = String(earlier.error_message || '').trim() || OPENAI_IMAGE_REPEATED_NOTE;
      const code = String(earlier.error_code || '').trim() || 'IMAGE_ATTEMPT_REPEATED';
      await publishFailure({ code, message, guidance: OPENAI_IMAGE_FAILURE_GUIDANCE, retryable: false });
      return res.status(409).json({
        ok: false,
        outcome: ['failed_terminal', 'failed_retryable'].includes(earlier.status) ? 'terminal' : 'uncertain',
        operationId,
        code,
        error: message,
      });
    }
    if (!acquired.acquired) {
      return res.status(202).json({ ok: true, outcome: 'executing', operationId });
    }

    executingImageOperations.add(operationId);
    try {
      const finishAttempt = (result) => {
        stmts.finishAttempt.run({
          id: acquired.attempt.id,
          // A request that never reached OpenAI (unreachable, or stopped by
          // the daily cap before it was sent) closes as retryable: nothing
          // was billed, and the recovery books nothing for it.
          status: result.outcome === 'uncertain'
            ? 'uncertain'
            : ((result.code === 'IMAGE_PROVIDER_UNREACHABLE' || (result.code === OPENAI_IMAGE_DAILY_CAP_REACHED_CODE && !result.sent))
              ? 'failed_retryable'
              : 'failed_terminal'),
          providerRequestId: null,
          providerConversationId: null,
          providerResponseId: null,
          httpStatus: result.upstreamStatus || null,
          errorCode: result.code,
          errorMessage: String(result.error || '').slice(0, 500),
          completedAt: new Date().toISOString(),
        });
      };
      const fail = async (result) => {
        finishAttempt(result);
        await publishFailure(openAIImageTerminalError(result));
        return res.status(409).json({
          ok: false,
          outcome: result.outcome,
          operationId,
          code: result.code,
          error: result.error,
          ...(result.usage ? { usage: result.usage } : {}),
        });
      };

      const requestAttachments = [];
      if (operation.parent_node_id) {
        const parentNode = stmts.getNode.get(operation.parent_node_id);
        const parentMessage = parentNode
          ? db.prepare(`SELECT attachments FROM messages WHERE id = ?`).get(parentNode.assistant_message_id)
          : null;
        const parentAttachment = parseAttachments(parentMessage?.attachments).find((attachment) => (
          String(attachment?.generatedImage?.imageId || '').trim() === parentNode?.attachment_image_id
        ));
        const generatedImage = parentAttachment?.generatedImage;
        const parentPath = resolveGeneratedImageReadPath({
          resolveSessionStateRoot,
          sessionId: generatedImage?.sessionId,
          relativePath: generatedImage?.relativePath,
        });
        if (!parentPath) {
          return await fail({
            ...openAIImageRequestRefusal(400, 'IMAGE_PARENT_UNAVAILABLE', 'The parent generated image is unavailable'),
            upstreamStatus: 400,
          });
        }
        requestAttachments.push({
          name: parentAttachment.name,
          type: parentAttachment.type,
          path: parentPath,
        });
      } else {
        // In the order they were attached: the first is the base image.
        for (const asset of stmts.listAssets.all(operationId)) {
          requestAttachments.push({
            name: asset.original_name || 'reference-image',
            type: asset.media_type,
            path: uploadPathForSha(asset.content_sha256),
          });
        }
      }

      // {size, quality, count, output_format, background}; any may be
      // missing, count is 1 then.
      let parameters = {};
      try {
        parameters = JSON.parse(operation.parameters_json || '{}') || {};
      } catch {}
      let requestBody;
      try {
        requestBody = normalizeOpenAIImageGenerateRequestBody({
          messageId: operation.queue_message_id,
          conversationId: operation.conversation_id,
          model: operation.selected_image_model,
          prompt: operation.prompt,
          n: parameters.count ?? 1,
          size: parameters.size,
          quality: parameters.quality,
          output_format: parameters.output_format,
          background: parameters.background,
          attachments: requestAttachments,
        });
      } catch (error) {
        return await fail(openAIImageRequestRefusal(400, 'IMAGE_REQUEST_INVALID', String(error?.message || 'Invalid image request')));
      }

      const result = await runOpenAIImageRequest(requestBody, {
        idempotencyKey: String(operation.idempotency_key || operation.id),
        preview: { conversationId: operation.conversation_id, messageId: operation.queue_message_id },
        scopeId: acquired.attempt.id,
      });
      if (!result.ok) return await fail(result);

      let finalizeError = null;
      try {
        const finalizeResponse = await fetch(`${selfBaseUrl}${remotePath}/api/response`, {
          method: 'POST',
          headers: selfHeaders,
          body: JSON.stringify({
            messageId: operation.queue_message_id,
            conversationId: operation.conversation_id,
            text: '',
            generatedImages: result.generatedImages,
            model: result.model || operation.selected_image_model,
            // A first try that may have been billed too: the reply says so.
            ...(result.note ? { imageNote: result.note } : {}),
          }),
        });
        const finalized = await finalizeResponse.json().catch(() => ({}));
        if (!finalizeResponse.ok) finalizeError = finalized?.error || `Image finalization failed (${finalizeResponse.status})`;
      } catch (error) {
        finalizeError = error?.message || 'Image finalization failed';
      }
      if (finalizeError) {
        return await fail({
          ok: false,
          outcome: 'uncertain',
          code: 'IMAGE_FINALIZATION_UNCERTAIN',
          error: `The images OpenAI returned could not be saved (${finalizeError}). The generation was billed; the message was not retried.`,
          upstreamStatus: 200,
          usage: result.usage,
        });
      }
      return res.json({
        ok: true,
        outcome: 'completed',
        operationId,
        generatedImageCount: result.generatedImages.length,
        usage: result.usage,
        ...(result.note ? { note: result.note } : {}),
      });
    } finally {
      executingImageOperations.delete(operationId);
    }
  });

  // The relay's own workers call this on this machine for an image turn
  // without an image operation (a row queued elsewhere than POST
  // /api/message: schedules, subscriptions, restart resume, the usage-limit
  // pause, relay-board rows). Like the execute route it is local only:
  // through the tunnel, or with a paired relay's token, it would spend the
  // owner's money outside the queue. One request per queue message: a
  // second call for the same message is refused.
  app.post('/api/openai/images/generate', auth, async (req, res) => {
    touchCli();
    if (!isTrulyLocalRequest(req)) {
      return res.status(403).json({ error: 'OpenAI image requests are reachable from this machine only' });
    }

    let requestBody;
    try {
      requestBody = normalizeOpenAIImageGenerateRequestBody(req.body);
    } catch (error) {
      return res.status(400).json({
        error: error?.message || 'Invalid OpenAI image request',
        code: 'IMAGE_REQUEST_INVALID',
        outcome: 'terminal',
      });
    }
    if (dispatchedImageMessages.has(requestBody.messageId)) {
      return res.status(409).json({
        error: OPENAI_IMAGE_REPEATED_NOTE,
        code: 'IMAGE_ATTEMPT_REPEATED',
        outcome: 'uncertain',
      });
    }

    const dispatched = noteDispatchedImageMessage(requestBody.messageId);
    // One run of the message: the claim's attempt id (a restart claims the
    // row anew), so its tries never merge into an earlier run's rows.
    // Known gap: this path (a row without an image operation) keeps no
    // attempt row, so a try a relay restart cuts off is booked nowhere; the
    // operation path's recovery books such a try as an estimate.
    // docs/providers.md says so.
    let claimId = '';
    try {
      claimId = String(stmts.findQById?.get?.(requestBody.messageId)?.attempt_id || '').trim();
    } catch {}
    const result = await runOpenAIImageRequest(requestBody, {
      idempotencyKey: `oar-image-${requestBody.messageId}`,
      preview: { conversationId: requestBody.conversationId, messageId: requestBody.messageId },
      scopeId: claimId ? `claim_${claimId}` : '',
    });
    // A request that never reached OpenAI may be sent again.
    if (result.ok || result.sent) dispatched.running = false;
    else dispatchedImageMessages.delete(requestBody.messageId);

    if (!result.ok) {
      return res.status(result.status).json({
        error: result.error,
        code: result.code,
        outcome: result.outcome,
        upstreamStatus: result.upstreamStatus,
        ...(result.detail ? { detail: result.detail } : {}),
        ...(result.relayProcessing ? { relayProcessing: true } : {}),
      });
    }
    return res.json({
      ok: true,
      generatedImages: result.generatedImages,
      model: result.model,
      endpoint: result.endpoint,
      usage: result.usage,
      // The worker hands it to /api/response as `imageNote`.
      ...(result.note ? { note: result.note } : {}),
    });
  });

  return { imageTurnRequeueStop };
}
