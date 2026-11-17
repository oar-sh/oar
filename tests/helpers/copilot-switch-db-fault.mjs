/**
 * Preloaded (NODE_OPTIONS `--import`) into a runtime the Copilot switch's
 * boot tests start (server/server-runtime-copilot-boot-failures.test.mjs):
 * one database step fails as it would on a damaged or read-only database.
 *
 * DB_FAULT_FIXTURE=migration  migration 0043's read of the stored setting
 *                             keys throws (a start whose switch is unset)
 * DB_FAULT_FIXTURE=write      storing the `copilot_enabled` setting throws
 *
 * Everything else the runtime does with its database runs as usual.
 */

import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const fault = String(process.env.DB_FAULT_FIXTURE || '').trim();
const Database = createRequire(path.join(repoRoot, 'server', 'server-runtime.mjs'))('better-sqlite3');
const prepare = Database.prototype.prepare;

Database.prototype.prepare = function prepareWithFault(sql, ...rest) {
  const text = String(sql).replace(/\s+/g, ' ').trim();
  if (fault === 'migration' && text === 'SELECT key FROM app_settings') {
    throw new Error('fixture: the settings table cannot be read');
  }
  const statement = prepare.call(this, sql, ...rest);
  if (fault === 'write' && text.startsWith('INSERT INTO app_settings')) {
    const run = statement.run;
    statement.run = function runWithFault(...args) {
      if (args[0] === 'copilot_enabled') throw new Error('fixture: attempt to write a readonly database');
      return run.apply(this, args);
    };
  }
  return statement;
};
