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
  const source = readSource('./attachments-view.js');
  const body = functionBody(source, 'refreshRepoBrowser');
  assert.doesNotMatch(body, /expandedPaths:\s*new Set\(\)/);
  assert.doesNotMatch(body, /collapsedPaths:\s*new Set\(\)/);
  assert.match(body, /parkRepoBrowserRestore\(\)/);
  // The parking helper is what bumps the seq and stashes the path.
  assert.match(source, /function parkRepoBrowserRestore\(\)[\s\S]*?repoBrowserRefreshSeq \+= 1[\s\S]*?\n\}/);
});

test('reopening the browser parks a restore so loaded branches rehydrate', () => {
  // The screenshot bug: openRepoBrowser refetched the lazy workspace tree with
  // the old expansion still in state but never rehydrated it, stranding the
  // selection on "Expand to load entries…" until a manual Refresh.
  const body = functionBody(readSource('./attachments-view.js'), 'openRepoBrowser');
  const parkIndex = body.indexOf('parkRepoBrowserRestore()');
  const loadIndex = body.indexOf('loadRepoBrowserTree()');
  assert.notEqual(parkIndex, -1, 'openRepoBrowser must park a restore for the workspace reload');
  assert.notEqual(loadIndex, -1);
  assert.ok(parkIndex < loadIndex, 'the restore must be parked before the reload starts');
  // Unlike Refresh, reopen must not wipe the visible tree while refetching.
  assert.doesNotMatch(body, /tree:\s*null/);
});

test('clicking a lazy-unloaded current dir loads it instead of collapsing it', () => {
  const source = readSource('./attachments-view.js');
  assert.match(source, /const isLoadedDir = isDir && !\(node\.lazy && !node\.childrenLoaded\);/);
  assert.match(source, /if \(isLoadedDir && isCurrent && !isCollapsed && targetPath\) \{/);
});

test('the folder pane self-heals a lazy-unloaded selection', () => {
  const body = functionBody(readSource('./attachments-view.js'), 'renderRepoFolder');
  assert.doesNotMatch(body, /Open this folder to load entries/);
  assert.match(body, /if \(!node\.loadingChildren\) void ensureRepoChildrenLoaded\(/);
});

test('concurrent child loads for the same path share one fetch', () => {
  const body = functionBody(readSource('./attachments-view.js'), 'ensureRepoChildrenLoaded');
  assert.match(body, /repoChildrenLoadsInFlight\.get\(nodePath\)/);
  assert.match(body, /repoChildrenLoadsInFlight\.set\(nodePath, load\)/);
  assert.match(body, /repoChildrenLoadsInFlight\.delete\(nodePath\)/);
});

test('the launch CWD path join is the cross-platform pure helper', () => {
  const source = readSource('./attachments-view.js');
  assert.match(functionBody(source, 'getRepoBrowserLaunchCwdPath'), /joinLaunchCwdPath\(/);
  assert.doesNotMatch(source, /joinWindowsPath/);
});

test('the CWD pick handler is captured before close clears it', () => {
  const source = readSource('./attachments-view.js');
  const confirmBody = functionBody(source, 'confirmRepoBrowserCwdPick');
  const captureIndex = confirmBody.indexOf('const handler = repoBrowserCwdPickHandler');
  const closeIndex = confirmBody.indexOf('closeRepoBrowser()');
  assert.notEqual(captureIndex, -1);
  assert.notEqual(closeIndex, -1);
  assert.ok(captureIndex < closeIndex, 'closeRepoBrowser nulls the handler, so it must be captured first');
  const closeBody = functionBody(source, 'closeRepoBrowser');
  assert.match(closeBody, /repoBrowserCwdPickHandler = null/);
  assert.match(closeBody, /classList\.remove\('cwd-pick-mode'\)/);
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
