import test from 'node:test';
import assert from 'node:assert/strict';

import { registerSessionsRoutes } from './sessions-routes.mjs';

function createMockApp() {
  const register = () => () => {};
  return { get: register(), post: register(), patch: register(), put: register(), delete: register() };
}

/** The install service's hook seam, without the service. */
function createFakeCliInstallService() {
  const successHooks = [];
  return {
    subscribe() { return () => {}; },
    onInstallSuccess(hook) { successHooks.push(hook); return () => {}; },
    getCachedStatusSnapshot: () => ({ providers: {}, install: {} }),
    async installSucceeded(detail) {
      for (const hook of successHooks) await hook(detail);
    },
  };
}

function registerWith({ copilotModelDiscoveryService }) {
  const cliInstallService = createFakeCliInstallService();
  registerSessionsRoutes(createMockApp(), {
    auth: (_req, _res, next) => next(),
    io: { emit() {} },
    db: { prepare: () => ({ run() {}, get() { return null; }, all() { return []; } }), transaction: (fn) => fn },
    stmts: {},
    cliInstallService,
    copilotModelDiscoveryService,
  });
  return { cliInstallService };
}

test('a Copilot CLI install or update refreshes the Copilot model discovery', async () => {
  const refreshes = [];
  const discovery = {
    setOnCatalogUpdated() {},
    async refresh(reason) { refreshes.push(reason); return { ok: true, models: [] }; },
  };
  const { cliInstallService } = registerWith({ copilotModelDiscoveryService: discovery });

  await cliInstallService.installSucceeded({ providerId: 'copilot', action: 'install' });
  await cliInstallService.installSucceeded({ providerId: 'copilot', action: 'update' });
  assert.deepEqual(refreshes, ['cli-install', 'cli-install']);
});

test('a Copilot discovery that fails after an install is logged, not thrown', async () => {
  const discovery = {
    setOnCatalogUpdated() {},
    async refresh() { throw new Error('Copilot client start timed out'); },
  };
  const { cliInstallService } = registerWith({ copilotModelDiscoveryService: discovery });
  const logged = [];
  const originalLog = console.log;
  console.log = (line) => { logged.push(String(line)); };
  try {
    await cliInstallService.installSucceeded({ providerId: 'copilot', action: 'install' });
  } finally {
    console.log = originalLog;
  }
  assert.ok(logged.some((line) => line.includes('Copilot model refresh after install failed: Copilot client start timed out')));
});
