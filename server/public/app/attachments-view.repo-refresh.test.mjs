import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// attachments-view.js and store.js touch window/document at module scope, so
// they cannot be imported under plain node. The behaviour that matters here is
// structural, so it is asserted against the source — the pattern already used by
// conversation-view.share-visibility.test.mjs.
function readSource(relativePath) {
  return fs.readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8');
}

function functionBody(source, name) {
  const start = [`export function ${name}(`, `export async function ${name}(`]
    .map((signature) => source.indexOf(signature))
    .find((index) => index !== -1) ?? -1;
  assert.notEqual(start, -1, `expected to find exported function ${name}`);
  const next = source.indexOf('\nexport ', start + 1);
  return source.slice(start, next === -1 ? source.length : next);
}

test('a refresh keeps the expansion sets so the open tree survives a filter toggle', () => {
  const body = functionBody(readSource('./attachments-view.js'), 'refreshRepoBrowser');
  assert.doesNotMatch(body, /expandedPaths:\s*new Set\(\)/);
  assert.doesNotMatch(body, /collapsedPaths:\s*new Set\(\)/);
  assert.match(body, /pendingRepoBrowserRestore = \{/);
  assert.match(body, /repoBrowserRefreshSeq \+= 1/);
});

test('a genuine root switch still discards the expansion sets', () => {
  const source = readSource('./attachments-view.js');
  for (const name of ['setRepoBrowserRoot', 'setRepoBrowserSessionInfo']) {
    const body = functionBody(source, name);
    assert.match(body, /expandedPaths:\s*new Set\(\)/, `${name} should still reset expandedPaths`);
    assert.match(body, /collapsedPaths:\s*new Set\(\)/, `${name} should still reset collapsedPaths`);
    assert.match(body, /pendingRepoBrowserRestore = null/, `${name} should drop a parked restore`);
  }
});

test('the parked restore is claimed before the queued reload is flushed', () => {
  const body = functionBody(readSource('./attachments-view.js'), 'loadRepoBrowserTree');
  const claimIndex = body.indexOf('takePendingRepoBrowserRestore()');
  const flushIndex = body.lastIndexOf('flushQueuedRepoBrowserReload()');
  assert.notEqual(claimIndex, -1);
  assert.ok(claimIndex < flushIndex, 'the queue flag must be read before flushing re-enters this function');
  assert.match(body, /repoBrowserReloadQueued \? null : takePendingRepoBrowserRestore\(\)/);
});

test('the restore aborts as soon as a newer refresh supersedes it', () => {
  const source = readSource('./attachments-view.js');
  const start = source.indexOf('async function applyRepoBrowserRestore(');
  assert.notEqual(start, -1);
  const body = source.slice(start, source.indexOf('\nexport ', start));
  const guards = body.match(/seq !== repoBrowserRefreshSeq/g) || [];
  assert.ok(guards.length >= 2, 'expected a seq guard inside and after the rehydration loop');
  assert.match(body, /planRepoRehydration\(/);
  assert.match(body, /deepestExistingAncestor\(/);
  assert.match(body, /withSuspendedRepoRender\(/);
});

test('both toolbar toggles persist their new value', () => {
  const source = readSource('./attachments-view.js');
  assert.match(
    functionBody(source, 'toggleRepoBrowserHidden'),
    /writeRepoBrowserHiddenPreference\(repoBrowserState\.activeRoot, nextValue\)/,
  );
  assert.match(
    functionBody(source, 'toggleRepoBrowserHeavy'),
    /writeRepoBrowserHeavyPreference\(repoBrowserState\.workspaceIncludeHeavy\)/,
  );
});

test('repoBrowserState seeds its filters from the stored preferences', () => {
  const source = readSource('./store.js');
  assert.match(source, /readRepoBrowserPreferences\(\)/);
  assert.doesNotMatch(source, /workspaceIncludeHidden:\s*false/);
  assert.doesNotMatch(source, /drivesIncludeHidden:\s*false/);
  assert.doesNotMatch(source, /workspaceIncludeHeavy:\s*false/);
});
