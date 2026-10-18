// Live rows for a window that ends above the conversation's end, without the
// DOM. Such a window (an "island": a jump to a pin or a search result, a
// reload around the place read, a kept window more was written below than one
// page holds) has rows between its newest row and the end that are not on the
// page. A live row put under it would hide that gap: the newer pages load
// from the window's newest row, and nothing would load what lies between. So
// the row is held back: the window keeps saying "newer rows exist", the
// jump-to-bottom button counts the row, and the newer pages bring it in their
// turn. Once the window meets the end, live rows are put on the page again.
//
// conversation-view.js keeps one of these for the window on the page and
// applies what it decides; transcript-jump-bottom.mjs draws the count.

/**
 * The rows held back for the window on the page. `follow` is told of every
 * change of that window: one that meets the end, or another conversation's,
 * holds none.
 */
export function createHeldBackLiveRows() {
  let conversationId = '';
  let ids = [];
  let unnamed = 0;
  return {
    /** A live row for `conversation` that was not put on the page. */
    note(conversation, messageId) {
      const id = String(conversation || '').trim();
      if (!id) return 0;
      if (id !== conversationId) {
        conversationId = id;
        ids = [];
        unnamed = 0;
      }
      const rowId = String(messageId || '').trim();
      if (!rowId) unnamed += 1;
      else if (!ids.includes(rowId)) ids.push(rowId);
      return ids.length + unnamed;
    },
    /** How many rows wait for `conversation`'s window. */
    count(conversation) {
      return String(conversation || '').trim() === conversationId ? ids.length + unnamed : 0;
    },
    /** The ids of the rows that wait, oldest first. */
    ids(conversation) {
      return String(conversation || '').trim() === conversationId ? ids.slice() : [];
    },
    /** The window on the page now. True when rows were let go. */
    follow({ conversationId: conversation = '', atTail = true } = {}) {
      const id = String(conversation || '').trim();
      if (!atTail && id === conversationId) return false;
      const had = ids.length + unnamed > 0;
      conversationId = atTail ? '' : id;
      ids = [];
      unnamed = 0;
      return had;
    },
  };
}

/**
 * Whether a newer page that says it is the last one really brings the window
 * to the end. It can have been fetched before a held-back row was written
 * (a page waiting in the prefetch buffer, a request answered while the row's
 * event was on its way): then a row the page lacks, and the page does not
 * show either, is still to come, and one more page is asked for. An empty
 * page ends it: a row that is still missing was deleted since.
 */
export function newerPageReachesEnd({ pageHasMore = false, pageMessageIds = [], heldBackIds = [], renderedIds = [] } = {}) {
  if (pageHasMore) return false;
  const page = (pageMessageIds || []).map((id) => String(id || '').trim()).filter(Boolean);
  if (!page.length) return true;
  const known = new Set([...page, ...(renderedIds || []).map((id) => String(id || '').trim())]);
  return (heldBackIds || []).every((id) => known.has(String(id || '').trim()));
}
