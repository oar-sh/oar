'use strict';

// The partial previews of the image turns this relay runs
// (shared/openai-image-previews.mjs has the contract): each partial OpenAI
// streams is written to
//   <session-state root>/<session>/generated-images/<conversation>/<queue message>/partials/img-01-try1-p0.png
// served to the owner's clients by its content URL, and announced with a
// socket event. The final images of the turn go to the reply's own folder
// (keyed by the reply's id, made when the reply is stored); the partials sit
// beside it under the queue message the turn answers.
//
// Nothing of a preview outlives its turn: a retry drops the first try's
// files, a failed request drops them all, and the turn's end (the reply or
// the failure note stored) removes the folder and tells the clients. A turn
// whose end never comes (a worker that died after the request) is ended by
// a timer; a crash of the relay leaves at most the partials of the turns it
// ran, and the next image turn of that conversation to end sweeps them.
//
// Agents never see a preview: partials are no attachment of any message, and
// only the owner's sockets get the events (share views have no socket).

import fsDefault from 'fs';
import path from 'path';

import { readImageHeader } from '../../shared/image-header.mjs';
import { OPENAI_IMAGE_MIME_BY_FORMAT } from '../../shared/openai-image-options.mjs';
import {
  OPENAI_IMAGE_PARTIAL_IMAGES,
  OPENAI_IMAGE_PARTIALS_DIR,
  OPENAI_IMAGE_PREVIEW_EVENT,
  OPENAI_IMAGE_PREVIEW_RESET_EVENT,
  OPENAI_IMAGE_PREVIEW_RESET_REASONS,
  OPENAI_IMAGE_STARTED_EVENT,
} from '../../shared/openai-image-previews.mjs';

// How long the partials of a request that ended wait for the turn's end.
export const OPENAI_IMAGE_PREVIEW_LEFTOVER_MS = 10 * 60_000;

const EXTENSION_BY_MIME = Object.freeze({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' });

function normalizeStorageSegment(value, fallback = 'item') {
  const text = String(value || '').trim();
  const compact = text.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return compact.slice(0, 96) || fallback;
}

/** The URL a partial is served at (GET /api/generated-image/:c/:m/partials/:file). */
export function openAIImagePartialContentUrl(conversationId, messageId, fileName) {
  return `/api/generated-image/${encodeURIComponent(conversationId)}/${encodeURIComponent(messageId)}/${OPENAI_IMAGE_PARTIALS_DIR}/${encodeURIComponent(fileName)}`;
}

/**
 * `resolveSessionStateRoot()` is the session-state root (no root: nothing is
 * written, the started and reset events still go out); `sessionIdFor(c)` the
 * session folder of a conversation (its SDK session id, else its id, as the
 * final images use); `emit(event, payload)` reaches the owner's clients.
 */
export function createOpenAIImagePreviewTurns({
  resolveSessionStateRoot = null,
  sessionIdFor = (conversationId) => conversationId,
  emit = () => {},
  logger = console,
  fs = fsDefault,
  leftoverMs = OPENAI_IMAGE_PREVIEW_LEFTOVER_MS,
  now = () => Date.now(),
} = {}) {
  const turns = new Map();

  const send = (event, payload) => {
    try {
      emit(event, payload);
    } catch (error) {
      logger?.warn?.(`IMAGE     preview event ${event} not sent: ${error?.message || error}`);
    }
  };

  const conversationDirOf = (conversationId) => {
    let root = '';
    try {
      root = String(resolveSessionStateRoot?.() || '').trim();
    } catch {}
    if (!root) return '';
    let sessionId = '';
    try {
      sessionId = String(sessionIdFor(conversationId) || '').trim();
    } catch {}
    const safeSession = normalizeStorageSegment(sessionId || conversationId || 'session', 'session');
    const safeConversation = normalizeStorageSegment(conversationId || 'conversation', 'conversation');
    return path.join(root, safeSession, 'generated-images', safeConversation);
  };

  const removeQuietly = (target, options = {}) => {
    try {
      fs.rmSync(target, { force: true, ...options });
    } catch {}
  };

  const removeIfEmpty = (dir) => {
    try {
      if (!fs.readdirSync(dir).length) fs.rmdirSync(dir);
    } catch {}
  };

  const removeFiles = (entry, { attempt = null } = {}) => {
    for (const [fileName, file] of entry.files) {
      if (attempt !== null && file.attempt !== attempt) continue;
      removeQuietly(file.path);
      entry.files.delete(fileName);
    }
  };

  // Partials folders of this conversation that no running turn owns: the
  // leftovers of a relay that went down mid-turn.
  const sweepConversation = (conversationId) => {
    const conversationDir = conversationDirOf(conversationId);
    if (!conversationDir) return;
    const owned = new Set();
    for (const entry of turns.values()) {
      if (entry.conversationId === conversationId) owned.add(entry.safeMessageId);
    }
    let names = [];
    try {
      names = fs.readdirSync(conversationDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const dirent of names) {
      if (!dirent.isDirectory() || owned.has(dirent.name)) continue;
      const messageDir = path.join(conversationDir, dirent.name);
      const partialsDir = path.join(messageDir, OPENAI_IMAGE_PARTIALS_DIR);
      if (!fs.existsSync(partialsDir)) continue;
      removeQuietly(partialsDir, { recursive: true });
      removeIfEmpty(messageDir);
    }
  };

  function finishEntry(entry, reason) {
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = null;
    turns.delete(entry.messageId);
    removeFiles(entry);
    if (entry.partialsDir) {
      removeQuietly(entry.partialsDir, { recursive: true });
      removeIfEmpty(path.dirname(entry.partialsDir));
    }
    send(OPENAI_IMAGE_PREVIEW_RESET_EVENT, {
      conversationId: entry.conversationId,
      messageId: entry.messageId,
      attempt: entry.attempt,
      reason,
    });
    sweepConversation(entry.conversationId);
  }

  /**
   * Ends the previews of a turn whose reply or failure note is stored:
   * removes its partials and tells the clients (`reason` 'done' or 'failed').
   * While the turn's request still runs the end waits for it. False for a
   * message with no previews.
   */
  function finish(messageId, reason = 'done') {
    const entry = turns.get(String(messageId || ''));
    if (!entry) return false;
    const why = OPENAI_IMAGE_PREVIEW_RESET_REASONS.includes(reason) && reason !== 'retry' ? reason : 'failed';
    if (entry.running) {
      entry.finishRequested = why;
      return true;
    }
    finishEntry(entry, why);
    return true;
  }

  /**
   * The previews of one image turn: the queue message `messageId` of
   * `conversationId`, with the request's size, quality, count and model.
   */
  function begin({ conversationId, messageId, size = '', quality = '', count = 1, model = '' } = {}) {
    const id = String(messageId || '').trim();
    const conversation = String(conversationId || '').trim();
    if (!id || !conversation) return null;
    // A second run of the same message (never more than one is sent): the
    // earlier one's previews go first.
    const earlier = turns.get(id);
    if (earlier) {
      earlier.running = false;
      finishEntry(earlier, 'failed');
    }
    const conversationDir = conversationDirOf(conversation);
    const safeMessageId = normalizeStorageSegment(id, 'message');
    const entry = {
      conversationId: conversation,
      messageId: id,
      safeMessageId,
      partialsDir: conversationDir ? path.join(conversationDir, safeMessageId, OPENAI_IMAGE_PARTIALS_DIR) : '',
      size: String(size || ''),
      quality: String(quality || ''),
      count: Math.max(1, Math.trunc(Number(count) || 1)),
      model: String(model || ''),
      startedAt: new Date(now()).toISOString(),
      attempt: 0,
      files: new Map(),
      running: true,
      finishRequested: null,
      timer: null,
    };
    turns.set(id, entry);

    const current = () => turns.get(id) === entry;
    const base = () => ({ conversationId: entry.conversationId, messageId: entry.messageId });

    return {
      /** A try went to OpenAI (1, then 2 after a retry). */
      started(attempt) {
        if (!current()) return;
        entry.attempt = Math.max(1, Math.trunc(Number(attempt) || 1));
        send(OPENAI_IMAGE_STARTED_EVENT, {
          ...base(),
          attempt: entry.attempt,
          size: entry.size,
          quality: entry.quality,
          count: entry.count,
          model: entry.model,
          startedAt: entry.startedAt,
        });
      },
      /**
       * A second try is about to start: the first try's partials go, and the
       * clients drop what they showed (`attempt` of the reset: the try whose
       * previews went).
       */
      retry() {
        if (!current()) return;
        removeFiles(entry, { attempt: entry.attempt });
        send(OPENAI_IMAGE_PREVIEW_RESET_EVENT, { ...base(), attempt: entry.attempt, reason: 'retry' });
      },
      /**
       * A partial image arrived: written, then announced. Resolves the event
       * payload, or null when it was not written (no root, empty data, the
       * try or the turn already over).
       */
      async partial({ imageIndex = 0, partialIndex = 0, b64 = '', outputFormat = '' } = {}) {
        if (!current() || !entry.partialsDir) return null;
        const attempt = entry.attempt;
        const bytes = Buffer.from(String(b64 || ''), 'base64');
        if (!bytes.length) return null;
        const format = String(outputFormat || '').trim().toLowerCase();
        const mime = readImageHeader(bytes)?.mime || OPENAI_IMAGE_MIME_BY_FORMAT[format] || 'image/png';
        const extension = EXTENSION_BY_MIME[mime] || 'png';
        const image = Math.max(0, Math.trunc(Number(imageIndex) || 0));
        const partial = Math.max(0, Math.trunc(Number(partialIndex) || 0));
        // Never more files than the turn asked for: OPENAI_IMAGE_PARTIAL_IMAGES
        // per image, for its count of images.
        if (partial >= OPENAI_IMAGE_PARTIAL_IMAGES || image >= entry.count) return null;
        const fileName = `img-${String(image + 1).padStart(2, '0')}-try${attempt}-p${partial}.${extension}`;
        const filePath = path.join(entry.partialsDir, fileName);
        const tmpPath = `${filePath}.${process.pid}.${now()}.tmp`;
        try {
          await fs.promises.mkdir(entry.partialsDir, { recursive: true });
          await fs.promises.writeFile(tmpPath, bytes);
          await fs.promises.rename(tmpPath, filePath);
        } catch (error) {
          removeQuietly(tmpPath);
          logger?.warn?.(`IMAGE     partial ${fileName} of ${entry.messageId} not written: ${error?.message || error}`);
          return null;
        }
        // The try ended (a retry, the turn's end) while the file was written.
        if (!current() || entry.attempt !== attempt) {
          removeQuietly(filePath);
          if (!current()) removeIfEmpty(entry.partialsDir);
          return null;
        }
        entry.files.set(fileName, { path: filePath, mime, attempt });
        const payload = {
          ...base(),
          attempt,
          imageIndex: image,
          partialIndex: partial,
          contentUrl: openAIImagePartialContentUrl(entry.conversationId, entry.messageId, fileName),
          mime,
          size: entry.size,
          quality: entry.quality,
          model: entry.model,
          startedAt: entry.startedAt,
        };
        send(OPENAI_IMAGE_PREVIEW_EVENT, payload);
        return payload;
      },
      /**
       * The request is over. A failed one drops its partials now (the turn's
       * end tells the clients once the note is stored); a good one keeps them
       * until the reply is. Either way a timer ends a turn whose end never
       * comes.
       */
      ended({ ok = false } = {}) {
        if (!current()) return;
        entry.running = false;
        if (!ok) removeFiles(entry);
        if (entry.finishRequested) {
          finishEntry(entry, entry.finishRequested);
          return;
        }
        entry.timer = setTimeout(() => {
          if (current()) finishEntry(entry, ok ? 'done' : 'failed');
        }, Math.max(0, Number(leftoverMs) || 0));
        entry.timer.unref?.();
      },
    };
  }

  /**
   * The file of a partial of a running turn, for the owner's content route:
   * `{ path, mime }` only for a file this turn wrote and still has, of the
   * conversation named. Null for anything else (no path is ever built from
   * the request).
   */
  function partialFile({ conversationId, messageId, fileName } = {}) {
    const entry = turns.get(String(messageId || ''));
    if (!entry || entry.conversationId !== String(conversationId || '')) return null;
    const file = entry.files.get(String(fileName || ''));
    if (!file) return null;
    return { path: file.path, mime: file.mime };
  }

  return {
    begin,
    finish,
    partialFile,
    has: (messageId) => turns.has(String(messageId || '')),
  };
}
