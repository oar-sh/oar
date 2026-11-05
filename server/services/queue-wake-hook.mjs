'use strict';

// Wakes the relay's queue delivery from the database itself. Every write
// that can make a queue row deliverable (a new pending row, a requeue, a
// retry time or owner or provider changed, a turn ending, a pending row
// cancelled or deleted) fires a TEMP trigger on this connection, which calls
// a JS function that only notes the reason and schedules one wake for after
// the current tick, so after the write's transaction. The function never
// touches the database and never throws.
//
// No row path has to remember to wake the queue, and none added later can
// forget: without it, a path that wrote a row and did not wake waited for
// the next poll. The triggers are TEMP (this connection only, nothing in the
// schema or the migrations). Their conditions name only the columns the
// queue table has, a self-test compiles every trigger inside a rolled-back
// savepoint, and on any error the triggers are dropped again and the caller
// falls back to polling: a broken trigger would fail every write to the
// queue.

export const QUEUE_WAKE_FUNCTION = 'oar_queue_wake';
const TRIGGER_PREFIX = 'oar_queue_wake_';
const TRIGGER_NAMES = ['insert', 'pending', 'settle', 'leave_pending', 'delete'].map((name) => `${TRIGGER_PREFIX}${name}`);
// A bulk statement calls the function once per row: the reasons of one tick
// are kept as a small set.
const MAX_REASONS = 8;

function queueColumns(db) {
  return new Set(db.prepare('PRAGMA table_info(queue)').all().map((column) => String(column.name)));
}

/** The CREATE TEMP TRIGGER statements, their conditions built from the columns there are. */
export function buildQueueWakeTriggerSql(columns) {
  const has = (name) => columns.has(name);
  if (!has('status')) throw new Error('queue has no status column');
  const changed = ["OLD.status IS NOT 'pending'"];
  for (const column of ['next_attempt_at', 'owner_sdk_session_id', 'provider']) {
    if (has(column)) changed.push(`OLD.${column} IS NOT NEW.${column}`);
  }
  const call = (reason) => `BEGIN SELECT ${QUEUE_WAKE_FUNCTION}('${reason}'); END`;
  return [
    // A new pending row.
    `CREATE TEMP TRIGGER ${TRIGGER_PREFIX}insert AFTER INSERT ON main.queue
      WHEN NEW.status = 'pending' ${call('insert')}`,
    // A row that became pending, or a pending row whose retry time, owner or
    // provider changed (a requeue, a hold released, a row moved to another
    // worker). A claim leaves pending and a lease refresh stays processing:
    // neither wakes.
    `CREATE TEMP TRIGGER ${TRIGGER_PREFIX}pending AFTER UPDATE ON main.queue
      WHEN NEW.status = 'pending' AND (${changed.join(' OR ')}) ${call('requeue')}`,
    // A turn ended: its session's next row, or one held behind it by the plan
    // boundary, may go now.
    `CREATE TEMP TRIGGER ${TRIGGER_PREFIX}settle AFTER UPDATE ON main.queue
      WHEN OLD.status = 'processing' AND NEW.status IS NOT 'processing' ${call('settle')}`,
    // A pending row cancelled, failed or parked: a row held behind it may go.
    `CREATE TEMP TRIGGER ${TRIGGER_PREFIX}leave_pending AFTER UPDATE ON main.queue
      WHEN OLD.status = 'pending' AND NEW.status NOT IN ('pending', 'processing') ${call('cancel')}`,
    // A pending or running row deleted (the cancel routes): the same.
    `CREATE TEMP TRIGGER ${TRIGGER_PREFIX}delete AFTER DELETE ON main.queue
      WHEN OLD.status IN ('pending', 'processing') ${call('delete')}`,
  ];
}

function dropTriggers(db) {
  for (const name of TRIGGER_NAMES) {
    try { db.exec(`DROP TRIGGER IF EXISTS temp.${name}`); } catch {}
  }
}

/**
 * Compiles every trigger by preparing a write of each kind, and runs one real
 * update, inside a savepoint that is rolled back: a condition naming a column
 * the table lacks fails here instead of on the first real write.
 */
function selfTestTriggers(db) {
  db.exec('SAVEPOINT oar_queue_wake_self_test');
  try {
    db.prepare('UPDATE queue SET status = status WHERE rowid = (SELECT rowid FROM queue LIMIT 1)').run();
    db.prepare('UPDATE queue SET status = status WHERE 0').run();
    db.prepare('DELETE FROM queue WHERE 0').run();
    db.prepare('INSERT INTO queue SELECT * FROM queue WHERE 0').run();
  } finally {
    db.exec('ROLLBACK TO oar_queue_wake_self_test');
    db.exec('RELEASE oar_queue_wake_self_test');
  }
}

/**
 * Installs the triggers on `db`. `onWake(reason)` runs once per tick in which
 * queue writes fired them, with the reasons joined. Returns `{ installed }`;
 * when false the triggers are gone again and the caller must poll.
 */
export function installQueueWakeHook(db, {
  onWake = () => {},
  log = () => {},
  schedule = setImmediate,
  selfTest = selfTestTriggers,
} = {}) {
  const reasons = new Set();
  let scheduled = false;
  let muted = false;

  function flush() {
    scheduled = false;
    const reason = [...reasons].join(',') || 'queue-write';
    reasons.clear();
    try {
      onWake(reason);
    } catch (error) {
      log(`queue wake failed: ${error?.message || error}`);
    }
  }

  // Called by SQLite from inside a write: no database access, no throw.
  function wakeFromTrigger(reason) {
    try {
      if (muted) return null;
      if (reasons.size < MAX_REASONS) reasons.add(String(reason || 'queue-write'));
      if (!scheduled) {
        scheduled = true;
        schedule(flush);
      }
    } catch {}
    return null;
  }

  try {
    const sql = buildQueueWakeTriggerSql(queueColumns(db));
    // The function first: a trigger calling a function that does not exist
    // yet would fail the write.
    db.function(QUEUE_WAKE_FUNCTION, { deterministic: false }, wakeFromTrigger);
    dropTriggers(db);
    for (const statement of sql) db.exec(statement);
    muted = true;
    try {
      selfTest(db);
    } finally {
      muted = false;
    }
    return { installed: true, triggers: [...TRIGGER_NAMES] };
  } catch (error) {
    dropTriggers(db);
    log(`queue wake triggers not installed, the queue is polled instead: ${error?.message || error}`);
    return { installed: false, error };
  }
}
