'use strict';

import fs from 'fs';
import path from 'path';

function normalizeStorageSegment(value, fallback = 'item') {
  const text = String(value || '').trim();
  const compact = text.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return compact.slice(0, 96) || fallback;
}

function parseMessageAttachments(rawAttachments, { parseAttachments, hydrateAttachment } = {}) {
  let attachments = [];
  if (typeof parseAttachments === 'function') {
    attachments = parseAttachments(rawAttachments);
  } else {
    try {
      attachments = JSON.parse(rawAttachments || '[]');
    } catch {
      attachments = [];
    }
  }
  if (!Array.isArray(attachments)) return [];
  if (typeof hydrateAttachment !== 'function') return attachments.filter(Boolean);
  return attachments.map((entry) => hydrateAttachment(entry)).filter(Boolean);
}

function resolveGeneratedImagePath({
  root,
  sessionId,
  relativePath,
} = {}) {
  const normalizedRoot = String(root || '').trim();
  const safeSession = normalizeStorageSegment(sessionId || '', '');
  const rawRelative = String(relativePath || '').replace(/\\/g, '/').trim();
  if (!normalizedRoot || !safeSession || !rawRelative) return null;
  const normalizedRelative = path.posix.normalize(rawRelative).replace(/^\/+/, '');
  if (!normalizedRelative || normalizedRelative.startsWith('..') || normalizedRelative.includes('/../')) return null;
  const baseDir = path.resolve(path.join(normalizedRoot, safeSession, 'generated-images'));
  const candidate = path.resolve(path.join(baseDir, normalizedRelative));
  if (!(candidate === baseDir || candidate.startsWith(`${baseDir}${path.sep}`))) return null;
  return candidate;
}

function resolveGeneratedImageConversationDir({
  root,
  sessionId,
  conversationId,
} = {}) {
  const normalizedRoot = String(root || '').trim();
  const safeSession = normalizeStorageSegment(sessionId || '', '');
  const safeConversation = normalizeStorageSegment(conversationId || '', '');
  if (!normalizedRoot || !safeSession || !safeConversation) return null;
  const baseDir = path.resolve(path.join(normalizedRoot, safeSession, 'generated-images'));
  const candidate = path.resolve(path.join(baseDir, safeConversation));
  if (!(candidate === baseDir || candidate.startsWith(`${baseDir}${path.sep}`))) return null;
  return candidate;
}

export function cleanupGeneratedImagesForConversation({
  conversationId,
  sdkSessionId = null,
  messageRows = [],
  parseAttachments = null,
  hydrateAttachment = null,
  resolveSessionStateRoot = null,
} = {}) {
  if (typeof resolveSessionStateRoot !== 'function') return;
  const root = String(resolveSessionStateRoot() || '').trim();
  const normalizedConversationId = String(conversationId || '').trim();
  if (!root || !normalizedConversationId) return;

  const candidateSessionIds = new Set();
  const filesToDelete = new Set();
  const normalizedSdkSessionId = String(sdkSessionId || '').trim();
  if (normalizedSdkSessionId) candidateSessionIds.add(normalizedSdkSessionId);
  candidateSessionIds.add(normalizedConversationId);

  for (const row of Array.isArray(messageRows) ? messageRows : []) {
    const attachments = parseMessageAttachments(row?.attachments, { parseAttachments, hydrateAttachment });
    for (const attachment of attachments) {
      const generatedImage = attachment?.generatedImage;
      if (!generatedImage || typeof generatedImage !== 'object') continue;
      const sessionId = String(generatedImage.sessionId || '').trim();
      const relativePath = String(generatedImage.relativePath || '').trim();
      if (sessionId) candidateSessionIds.add(sessionId);
      const filePath = resolveGeneratedImagePath({
        root,
        sessionId: sessionId || normalizedSdkSessionId || normalizedConversationId,
        relativePath,
      });
      if (!filePath) continue;
      filesToDelete.add(filePath);
    }
  }

  for (const filePath of filesToDelete) {
    try {
      fs.rmSync(filePath, { force: true });
    } catch {}
  }

  for (const sessionId of candidateSessionIds) {
    const conversationDir = resolveGeneratedImageConversationDir({
      root,
      sessionId,
      conversationId: normalizedConversationId,
    });
    if (!conversationDir) continue;
    try {
      fs.rmSync(conversationDir, { recursive: true, force: true });
    } catch {}
  }
}
