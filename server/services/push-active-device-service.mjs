'use strict';

/**
 * Active-device tracking for push suppression.
 *
 * "Active" means: a connected socket whose client explicitly reported itself
 * visible via a `device_visibility` heartbeat within the staleness window. A
 * connected socket alone is not enough — the client keeps its transport open
 * for a grace period after backgrounding, so a pocketed phone can hold a live
 * socket for tens of seconds.
 */

export const DEVICE_VISIBILITY_STALE_MS = 90_000;

/**
 * @param {object} options
 * @param {() => Iterable<import('socket.io').Socket>} options.getSockets connected sockets of the main namespace
 * @param {number} [options.staleMs]
 * @param {() => number} [options.now]
 */
export function createActiveDeviceTracker({ getSockets, staleMs = DEVICE_VISIBILITY_STALE_MS, now = () => Date.now() }) {
  /**
   * Bind visibility tracking to a freshly connected socket. Call from the
   * io `connection` handler.
   */
  function registerSocket(socket) {
    if (!socket) return;
    if (socket.recovered === true && socket.data) {
      // connectionStateRecovery restores socket.data from the recovered
      // session, so a phone that slept with deviceVisible=true would come back
      // still claiming to be visible and suppress push for every device.
      // Reset and wait for the client's connect-time heartbeat (one round
      // trip). The staleness window below is the independent second guard.
      socket.data.deviceVisible = false;
    }
    socket.on('device_visibility', (payload = {}) => {
      const deviceId = String(payload?.deviceId || '').trim();
      if (deviceId) socket.data.deviceId = deviceId;
      socket.data.deviceVisible = payload?.visible === true;
      socket.data.deviceVisibleAt = now();
    });
  }

  function hasActiveDevice() {
    for (const socket of getSockets()) {
      if (!socket || socket.connected === false) continue;
      if (socket.data?.deviceVisible !== true) continue;
      const visibleAt = Number(socket.data?.deviceVisibleAt || 0);
      if (!Number.isFinite(visibleAt) || visibleAt <= 0) continue;
      if ((now() - visibleAt) > staleMs) continue;
      return true;
    }
    return false;
  }

  return { registerSocket, hasActiveDevice };
}
