import test from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveDefaultSessionWorkspaceRootState,
  resolveLaunchWorkspaceRootPath,
} from './workspace-root-defaults-service.mjs';

// platform-agnostic: normalizePath is injected, so the stored root is an opaque
// string here — the win32 fixtures never reach real path semantics.

test('resolveDefaultSessionWorkspaceRootState returns empty state when setting is unset', () => {
  const result = resolveDefaultSessionWorkspaceRootState({
    storedPath: '',
    normalizePath: () => '/unused',
  });
  assert.deepEqual(result, { path: null, warning: null });
});

test('resolveDefaultSessionWorkspaceRootState keeps valid normalized path', () => {
  const result = resolveDefaultSessionWorkspaceRootState({
    storedPath: 'C:\\work',
    normalizePath: (value) => String(value || '').trim(),
  });
  assert.equal(result.path, 'C:\\work');
  assert.equal(result.warning, null);
});

test('resolveDefaultSessionWorkspaceRootState emits warning for invalid stored path', () => {
  const result = resolveDefaultSessionWorkspaceRootState({
    storedPath: 'C:\\missing-folder',
    normalizePath: () => null,
  });
  assert.equal(result.path, null);
  assert.equal(result.warning, 'Saved default CWD is unavailable. Update it in Settings.');
});

test('resolveLaunchWorkspaceRootPath prefers configured conversation path', () => {
  const result = resolveLaunchWorkspaceRootPath({
    configuredWorkspaceRootPath: 'C:\\configured',
    pendingSessionWorkspaceRootPath: 'C:\\pending',
    defaultSessionWorkspaceRootPath: 'C:\\default',
    workspaceRootPath: 'C:\\relay',
  });
  assert.equal(result, 'C:\\configured');
});

test('resolveLaunchWorkspaceRootPath falls back to pending then default then relay root', () => {
  const pendingResult = resolveLaunchWorkspaceRootPath({
    configuredWorkspaceRootPath: '',
    pendingSessionWorkspaceRootPath: 'C:\\pending',
    defaultSessionWorkspaceRootPath: 'C:\\default',
    workspaceRootPath: 'C:\\relay',
  });
  assert.equal(pendingResult, 'C:\\pending');

  const defaultResult = resolveLaunchWorkspaceRootPath({
    configuredWorkspaceRootPath: '',
    pendingSessionWorkspaceRootPath: '',
    defaultSessionWorkspaceRootPath: 'C:\\default',
    workspaceRootPath: 'C:\\relay',
  });
  assert.equal(defaultResult, 'C:\\default');

  const relayResult = resolveLaunchWorkspaceRootPath({
    configuredWorkspaceRootPath: '',
    pendingSessionWorkspaceRootPath: '',
    defaultSessionWorkspaceRootPath: '',
    workspaceRootPath: 'C:\\relay',
  });
  assert.equal(relayResult, 'C:\\relay');
});
