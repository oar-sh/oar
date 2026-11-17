// The drive and session-root routes serve the paths of the platform the
// relay hands them (`filePlatform`), like the other file routes: 'win32'
// runs their Windows half, which starts at the drive list, and 'linux'
// their POSIX half, which never reads it. The platform is injected, so both
// halves run on any host.
import test from 'node:test';
import assert from 'node:assert/strict';

import { captureRoutes, invokeRoute, makeRouteDeps } from './messages-routes-test-harness.mjs';
import { normalizeDriveAbsolutePath, normalizeLinuxAbsolutePath } from '../services/drives-path-helpers.mjs';

const ROUTES = [
  '/api/drives/roots',
  '/api/drives/list',
  '/api/session-root/list',
  '/api/drives/files-preview',
];

function fileRoutes(filePlatform) {
  const calls = { drives: 0, linuxListings: 0 };
  const routes = captureRoutes(makeRouteDeps({
    filePlatform,
    parseBooleanQueryFlag: (_value, fallback) => fallback,
    normalizeLinuxAbsolutePath,
    normalizeDriveAbsolutePath,
    fetchBrowsableDrives: (callback) => {
      calls.drives += 1;
      callback(new Error('drive list read'));
    },
    fetchLinuxDirectoryEntries: (_dirPath, _options, callback) => {
      calls.linuxListings += 1;
      callback(new Error('linux listing read'));
    },
  }));
  return { routes, calls };
}

test('with filePlatform win32 each drive and session-root route reads the drive list first', async () => {
  for (const route of ROUTES) {
    const { routes, calls } = fileRoutes('win32');
    const answer = await invokeRoute(routes, 'GET', route, { query: { path: 'not-absolute' } });
    assert.equal(calls.drives, 1, route);
    assert.equal(calls.linuxListings, 0, route);
    assert.equal(answer.status, 500, route);
    assert.equal(answer.body.error, 'drive list read', route);
  }
});

test('with filePlatform linux no drive or session-root route reads the drive list', async () => {
  const expected = {
    '/api/drives/roots': { status: 500, error: 'linux listing read', linuxListings: 1 },
    '/api/drives/list': { status: 400, error: 'Invalid Linux path', linuxListings: 0 },
    '/api/session-root/list': { status: 400, error: 'Invalid Linux path', linuxListings: 0 },
    '/api/drives/files-preview': { status: 400, error: 'Invalid Linux file path', linuxListings: 0 },
  };
  for (const route of ROUTES) {
    const { routes, calls } = fileRoutes('linux');
    const answer = await invokeRoute(routes, 'GET', route, { query: { path: 'not-absolute' } });
    assert.equal(calls.drives, 0, route);
    assert.equal(calls.linuxListings, expected[route].linuxListings, route);
    assert.equal(answer.status, expected[route].status, route);
    assert.equal(answer.body.error, expected[route].error, route);
  }
});
