import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { applySchema } from '../db-schema.mjs';
import { createMessageRepository } from '../repositories/message-repository.mjs';
import { createSessionRepository } from '../repositories/session-repository.mjs';
import { REMOTE_RELAY_ERROR_CODES as CODES } from '../../shared/remote-relay-contract.mjs';
import { createRelayScheduleService } from '../services/relay-schedule-service.mjs';
import { registerRelayScheduleRoutes } from './relay-schedule-routes.mjs';

// The browser's routes for schedules: the active list and Cancel, and
// nothing for another relay's agent.

const CONV = 'conv-fixture-agent';

function createMockApp() {
  const routes = new Map();
  const register = (method) => (routePath, ...handlers) => routes.set(`${method} ${routePath}`, handlers);
  return { routes, get: register('GET'), post: register('POST'), delete: register('DELETE') };
}

async function callRoute(handlers, req = {}) {
  const response = {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
  const request = Object.assign(req, { body: req.body || {}, query: req.query || {}, params: req.params || {}, headers: req.headers || {} });
  for (const handler of handlers) {
    let next = false;
    await handler(request, response, () => { next = true; });
    if (!next) break;
  }
  return response;
}

function setup({ withService = true } = {}) {
  const db = new Database(':memory:');
  applySchema(db);
  const at = new Date(Date.now() - 60_000).toISOString();
  db.prepare(`INSERT INTO conversations (id, title, preferred_relay_mode, created_at, updated_at) VALUES (?, 'Coordinator', 'agent', ?, ?)`).run(CONV, at, at);
  const stmts = { ...createSessionRepository(db), ...createMessageRepository(db) };
  const service = createRelayScheduleService({ db, stmts, logger: { log() {}, warn() {} } });
  const app = createMockApp();
  registerRelayScheduleRoutes(app, {
    auth: (_req, _res, next) => next(),
    ...(withService ? { relayScheduleService: service } : {}),
    remoteRelayInbound: { listRelays: () => [], inboundEnabled: () => true },
  });
  return { service, route: (key) => app.routes.get(key) };
}

test('the browser lists the active schedules and cancels one', async () => {
  const { service, route } = setup();
  const kept = service.create({ conversationId: CONV, createdBy: CONV, text: 'keep', everyMinutes: 60, title: 'Kept' });
  const gone = service.create({ conversationId: CONV, createdBy: CONV, text: 'go', everyMinutes: 30 });
  const listed = await callRoute(route('GET /api/relay-schedules'));
  assert.equal(listed.body.available, true);
  assert.deepEqual(listed.body.schedules.map((schedule) => schedule.id), [kept.id, gone.id]);
  const cancelled = await callRoute(route('DELETE /api/relay-schedules/:id'), { params: { id: gone.id } });
  assert.equal(cancelled.statusCode, 200);
  assert.equal(cancelled.body.schedule.endReason, 'unscheduled');
  assert.deepEqual(service.listActive().map((schedule) => schedule.id), [kept.id]);
  const missing = await callRoute(route('DELETE /api/relay-schedules/:id'), { params: { id: 'sch_missing' } });
  assert.equal(missing.statusCode, 404);
  assert.equal(missing.body.code, CODES.notFound);
});

test('another relay\'s request is refused, and a relay without the service lists nothing', async () => {
  const { service, route } = setup();
  const schedule = service.create({ conversationId: CONV, createdBy: CONV, text: 'x', everyMinutes: 5 });
  const fromRelay = { headers: { 'x-oar-remote-origin': 'relay-fixture-b', 'x-oar-remote-hops': '1' } };
  assert.equal((await callRoute(route('GET /api/relay-schedules'), { ...fromRelay })).statusCode, 403);
  assert.equal((await callRoute(route('DELETE /api/relay-schedules/:id'), { ...fromRelay, params: { id: schedule.id } })).statusCode, 403);
  assert.equal(service.listActive().length, 1);

  const bare = setup({ withService: false });
  assert.deepEqual((await callRoute(bare.route('GET /api/relay-schedules'))).body, { available: false, schedules: [] });
  const off = await callRoute(bare.route('DELETE /api/relay-schedules/:id'), { params: { id: 'sch_x' } });
  assert.equal(off.statusCode, 503);
});
