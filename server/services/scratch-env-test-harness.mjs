// The environment for any process a test starts: every folder a relay, the
// preinstall or npm could write the user's state to lies inside `root`.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after } from 'node:test';

import { resolveOarRoot } from './oar-state-migration-service.mjs';

export const SCRATCH_KEYS = ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'OAR_STATE_ROOT'];

export function scratchEnv(root, extra = {}) {
  const env = { ...process.env };
  // Drop the user's own values under any case before setting scratch ones.
  for (const key of Object.keys(env)) {
    if (SCRATCH_KEYS.includes(key.toUpperCase()) || key.toUpperCase() === 'COPILOT_WEB_RELAY_DATA_DIR') delete env[key];
  }
  Object.assign(env, {
    HOME: path.join(root, 'home'),
    USERPROFILE: path.join(root, 'home'),
    APPDATA: path.join(root, 'home', 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(root, 'home', 'AppData', 'Local'),
    OAR_STATE_ROOT: path.join(root, 'state'),
  }, extra);
  assertScratch(env, root);
  return env;
}

// For a test file that runs the rescue or the take-over in its own process:
// this process's home and state folders point into a scratch folder until
// the file ends (os.homedir() and the default state root follow them).
export function useScratchProcessEnv() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oar-scratch-home-'));
  const scratch = scratchEnv(root);
  const saved = Object.fromEntries(SCRATCH_KEYS.map((key) => [key, process.env[key]]));
  for (const key of SCRATCH_KEYS) process.env[key] = scratch[key];
  after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  assertScratch(process.env, root);
  for (const resolved of [os.homedir(), resolveOarRoot({ ...process.env, OAR_STATE_ROOT: '' }), resolveOarRoot(process.env)]) {
    const relative = path.relative(root, resolved);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), `${resolved} must lie inside ${root}`);
  }
  return root;
}

// Refuses an environment that names a real home or state folder.
export function assertScratch(env, root) {
  const inside = (value) => {
    const relative = path.relative(path.resolve(root), path.resolve(String(value)));
    return relative && !relative.startsWith('..') && !path.isAbsolute(relative);
  };
  for (const key of SCRATCH_KEYS) {
    const entry = Object.entries(env).find(([name]) => name.toUpperCase() === key);
    assert.ok(entry && inside(entry[1]), `${key} must lie inside the test's scratch folder, got ${entry?.[1]}`);
  }
}
