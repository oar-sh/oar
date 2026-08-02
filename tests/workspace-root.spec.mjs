import { test, expect } from '@playwright/test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  resolveRepositoryWorkspaceRoot,
  resolveStartupWorkspaceRoot,
  resolveWorkspaceRootPath,
  workspaceRootDisplayName,
  parseCdCommandTarget,
  resolveCdCommandPath,
} from '../server/workspace-root.mjs';

test('prefers an explicit cwd root and falls back cleanly', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-root-'));
  const missingRoot = path.join(tempRoot, 'missing');
  const fallbackRoot = path.join(tempRoot, 'fallback');
  fs.mkdirSync(fallbackRoot, { recursive: true });

  expect(resolveWorkspaceRootPath(tempRoot, fallbackRoot)).toBe(path.resolve(tempRoot));
  expect(resolveWorkspaceRootPath(missingRoot, fallbackRoot)).toBe(path.resolve(fallbackRoot));
  expect(workspaceRootDisplayName(tempRoot)).toBe(path.basename(path.resolve(tempRoot)));

  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('prefers launch cwd env and falls back to repository root', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-launch-'));
  const serverDir = path.join(tempRoot, 'server');
  const launchRoot = path.join(tempRoot, 'launch-cwd');
  fs.mkdirSync(serverDir, { recursive: true });
  fs.mkdirSync(launchRoot, { recursive: true });

  expect(resolveRepositoryWorkspaceRoot(launchRoot, serverDir)).toBe(path.resolve(launchRoot));
  expect(resolveRepositoryWorkspaceRoot('', serverDir)).toBe(path.resolve(tempRoot));
  expect(resolveRepositoryWorkspaceRoot(undefined, serverDir)).toBe(path.resolve(tempRoot));
  const previous = process.env.COPILOT_WORKSPACE_ROOT;
  process.env.COPILOT_WORKSPACE_ROOT = launchRoot;
  expect(resolveStartupWorkspaceRoot(serverDir)).toBe(path.resolve(launchRoot));
  process.env.COPILOT_WORKSPACE_ROOT = path.join(tempRoot, 'elsewhere');
  expect(resolveStartupWorkspaceRoot(serverDir)).toBe(path.resolve(tempRoot));
  if (previous === undefined) {
    delete process.env.COPILOT_WORKSPACE_ROOT;
  } else {
    process.env.COPILOT_WORKSPACE_ROOT = previous;
  }

  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('parses plain cd commands safely', async () => {
  expect(parseCdCommandTarget('cd U:\\')).toBe('U:\\');
  expect(parseCdCommandTarget('cd /d "X:\\programs"')).toBe('X:\\programs');
  expect(parseCdCommandTarget('cd ..')).toBe('..');
  expect(parseCdCommandTarget('cd')).toBeNull();
  expect(parseCdCommandTarget('cd U:\\ && dir')).toBeNull();
  expect(parseCdCommandTarget('echo cd U:\\')).toBeNull();
});

test('resolves cd command targets relative to active root', async () => {
  const resolvedDrive = resolveCdCommandPath('U:', 'X:\\workspace\\repo');
  expect(resolvedDrive).toBe('U:\\');

  const resolvedRelative = resolveCdCommandPath('..\\server', 'X:\\workspace\\repo\\tests');
  expect(resolvedRelative).toBe(path.resolve('X:\\workspace\\repo\\tests', '..\\server'));
});
