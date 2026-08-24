// Advisory vision-capability heuristic for the composer.
//
// The browser only ever receives a list of model ID strings; the relay's model
// catalog does not carry `capabilities.supports.vision`. Until that metadata is
// plumbed through we cannot be authoritative, so this module is deliberately
// conservative: it warns only about models known to be text-only and stays
// silent whenever it does not recognise the id. The warning never blocks send.

const KNOWN_TEXT_ONLY_PATTERNS = [
  /^o1-mini/,
  /^o1-preview/,
  /^text-embedding/,
  /^codestral/,
  /^code-davinci/,
  /^text-davinci/,
  /-instruct-text$/,
  /^deepseek-coder/,
  /^qwen[\w.-]*-coder/,
];

export function normalizeModelId(modelId) {
  return String(modelId || '').trim().toLowerCase();
}

/**
 * Returns false only for models we positively recognise as text-only.
 * Unknown ids are assumed vision-capable so the composer stays quiet rather
 * than crying wolf on every model it has not heard of.
 */
export function modelLikelySupportsVision(modelId) {
  const normalized = normalizeModelId(modelId);
  if (!normalized) return true;
  return !KNOWN_TEXT_ONLY_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function countImageAttachments(attachments = []) {
  const list = Array.isArray(attachments) ? attachments : [];
  return list.filter((attachment) => {
    if (!attachment) return false;
    if (typeof attachment.isImage === 'boolean') return attachment.isImage;
    return String(attachment.type || '').toLowerCase().startsWith('image/');
  }).length;
}

export function shouldWarnAboutImageAttachments(modelId, attachments = []) {
  if (!countImageAttachments(attachments)) return false;
  return !modelLikelySupportsVision(modelId);
}

export function imageAttachmentWarningText(modelId, attachments = []) {
  if (!shouldWarnAboutImageAttachments(modelId, attachments)) return '';
  const count = countImageAttachments(attachments);
  const noun = count === 1 ? 'image' : 'images';
  const label = String(modelId || '').trim() || 'the selected model';
  return `${label} may not read ${noun} — the ${noun} will be sent as a file reference instead.`;
}
