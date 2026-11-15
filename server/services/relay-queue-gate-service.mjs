'use strict';

// Boot report for parked rows. Nothing parks or releases a row any more, and
// a row parked long ago must not start running on a restart, so this only
// counts them and logs one line; it changes no row.
export function reportParkedQueueAtBoot({ stmts, log } = {}) {
  const summary = stmts?.summarizeParkedQueue?.get?.() || null;
  const count = Number(summary?.count || 0);
  const oldestParkedAt = count > 0 ? (summary?.oldest_parked_at || null) : null;
  if (count > 0 && typeof log === 'function') {
    log(`${count} parked message(s) found, oldest parked at ${oldestParkedAt || 'unknown'}; they stay parked and can be cancelled from the conversation`);
  }
  return { count, oldestParkedAt };
}
