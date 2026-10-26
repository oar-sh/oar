'use strict';

// Relay schedules, for the browser: the active schedules (the "scheduled"
// marker and the list in the header) and Cancel. Agents use the
// relay_tool instead; a request from another relay's agent is
// refused here, so only this relay's user cancels a schedule from outside
// its conversation.

import { REMOTE_RELAY_ERROR_CODES } from '../../shared/remote-relay-contract.mjs';
import { readRemoteRelayRequest } from '../services/remote-relay-inbound.mjs';
import { RelayScheduleError } from '../services/relay-schedule-service.mjs';

const RELAY_SCHEDULE_ERROR_STATUS = Object.freeze({
  invalid: [400, REMOTE_RELAY_ERROR_CODES.invalidInput],
  notFound: [404, REMOTE_RELAY_ERROR_CODES.notFound],
  limit: [409, REMOTE_RELAY_ERROR_CODES.scheduleLimit],
  unavailable: [503, REMOTE_RELAY_ERROR_CODES.unsupported],
});

export function registerRelayScheduleRoutes(app, deps) {
  const {
    auth,
    relayScheduleService = null,
    remoteRelayInbound = null,
  } = deps;

  function refuseRemote(req, res) {
    const request = readRemoteRelayRequest(req, remoteRelayInbound || {});
    if (!request.remote) return false;
    res.status(403).json({ error: 'Relay schedules are managed by this relay\'s user and its own agents only.' });
    return true;
  }

  // GET /api/relay-schedules — every active schedule.
  app.get('/api/relay-schedules', auth, (req, res) => {
    if (refuseRemote(req, res)) return;
    if (!relayScheduleService?.isAvailable?.()) return res.json({ available: false, schedules: [] });
    res.json({ available: true, schedules: relayScheduleService.listActive() });
  });

  // DELETE /api/relay-schedules/:id — the user cancels a schedule.
  app.delete('/api/relay-schedules/:id', auth, (req, res) => {
    if (refuseRemote(req, res)) return;
    try {
      const schedule = relayScheduleService
        ? relayScheduleService.unschedule({ scheduleId: String(req.params.id || '') })
        : (() => { throw new RelayScheduleError('unavailable', 'Schedules are not available on this relay right now.'); })();
      res.json({ ok: true, schedule });
    } catch (error) {
      if (error instanceof RelayScheduleError) {
        const [status, code] = RELAY_SCHEDULE_ERROR_STATUS[error.code] || [400, REMOTE_RELAY_ERROR_CODES.invalidInput];
        return res.status(status).json({ error: error.message, code });
      }
      res.status(500).json({ error: `Cancel failed: ${String(error?.message || error)}`, code: REMOTE_RELAY_ERROR_CODES.internal });
    }
  });
}
