'use strict';

// Every pending row queued into an existing conversation is written here. A
// row of an archived conversation is neither claimed nor woken
// (QUEUE_ROW_NOT_ARCHIVED_SQL in message-repository.mjs), so the write that
// queues it brings the conversation back in the same transaction, and the
// caller announces it after the commit with unarchivedConversationEvent, as
// POST /api/conversation/:id/unarchive does.
// Only the routes (message intake, board actions) bring a Claude Cloud chat's cloud session back too.

const unarchiveStatements = new WeakMap();

function unarchiveStatement(db) {
  let statement = unarchiveStatements.get(db);
  if (!statement) {
    // The unarchive route's update (conversation-lifecycle-routes.mjs), held
    // to an archived row that is not deleted, so the caller learns whether
    // this write brought the conversation back.
    statement = db.prepare(`UPDATE conversations SET archived = 0, updated_at = ? WHERE id = ? AND archived = 1 AND status != 'deleted'`);
    unarchiveStatements.set(db, statement);
  }
  return statement;
}

/**
 * In one transaction (a savepoint inside the caller's): unarchives the
 * conversation if it is archived and inserts the row with `stmts.insertQ`,
 * whose arguments `queueArgs` are (the conversation id is the second).
 * Returns `{ unarchived }`.
 */
export function queueIntoConversation(db, stmts, queueArgs) {
  return db.transaction(() => {
    const unarchived = Number(unarchiveStatement(db).run(new Date().toISOString(), queueArgs[1])?.changes) === 1;
    stmts.insertQ.run(...queueArgs);
    return { unarchived };
  })();
}

/** The socket event and payload of an unarchive, the route's own. */
export function unarchivedConversationEvent(conversationId) {
  return ['conversation_archived', { conversationId, archived: false }];
}
