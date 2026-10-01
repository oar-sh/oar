import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { migrateWorkspaceRootSettings } from './0006-workspace-root-settings.mjs';

const columns = (db, table) => db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name);

test('creates the per-folder settings table once and keeps its rows', () => {
  const db = new Database(':memory:');
  assert.deepEqual(migrateWorkspaceRootSettings(db), { applied: true, tableCreated: true });
  assert.deepEqual(columns(db, 'workspace_root_settings'), ['path_key', 'path', 'attribution_mode', 'updated_at']);
  db.prepare(`INSERT INTO workspace_root_settings (path_key, path, attribution_mode, updated_at) VALUES ('/home/dev/demo', '/home/dev/demo', 'off', '2026-10-01T10:00:00.000Z')`).run();
  assert.deepEqual(migrateWorkspaceRootSettings(db), { applied: false, tableCreated: false });
  assert.equal(db.prepare(`SELECT attribution_mode FROM workspace_root_settings WHERE path_key = '/home/dev/demo'`).get().attribution_mode, 'off');
});
