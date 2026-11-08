// Partial previews of an OpenAI image turn: what the relay asks OpenAI to
// stream, where the partial files live and the socket events the owner's
// open clients get while the image is made. Agents never see previews: their
// replies carry the final images only.
//
// SDK-free and side-effect free: imported by the server and the browser.

// Partial images per image OpenAI streams before the final one (0 to 3; 0
// turns streaming off).
export const OPENAI_IMAGE_PARTIAL_IMAGES = 2;

// The folder next to a turn's final images that holds its partials; emptied
// and removed when the turn ends, well or not.
export const OPENAI_IMAGE_PARTIALS_DIR = 'partials';

// Socket events (owner clients only, never shared views):
//
// `image_started` — a try of an image turn went to OpenAI:
//   { conversationId, messageId, attempt, size, quality, count, model, startedAt }
//   The client shows a placeholder with an elapsed timer from `startedAt`
//   and the size and quality; a client that opens the chat later sees the
//   running turn without it (its timer starts from the turn's own time).
//
// `image_preview` — a partial image arrived:
//   { conversationId, messageId, attempt, imageIndex, partialIndex,
//     contentUrl, mime, size, quality, model, startedAt }
//   `messageId` is the user message (queue row) the turn answers; `attempt`
//   counts the tries of that turn (1, then 2 after a retry); `imageIndex`
//   the image of a count > 1 turn (0-based); `partialIndex` OpenAI's
//   partial_image_index; `startedAt` the ISO time the first try began, for
//   the elapsed timer.
//
// `image_preview_reset` — drop the previews shown so far for that turn:
//   { conversationId, messageId, attempt, reason }
//   `reason` is 'retry' (a second try starts: the first try's partials go),
//   'done' (the final message is there) or 'failed'.
export const OPENAI_IMAGE_STARTED_EVENT = 'image_started';
export const OPENAI_IMAGE_PREVIEW_EVENT = 'image_preview';
export const OPENAI_IMAGE_PREVIEW_RESET_EVENT = 'image_preview_reset';
export const OPENAI_IMAGE_PREVIEW_RESET_REASONS = Object.freeze(['retry', 'done', 'failed']);
