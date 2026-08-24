'use strict';

/**
 * Web Push subscription management. All endpoints sit behind the token auth
 * middleware, so shared read-only viewers (who authenticate with a share
 * token, not the relay token) cannot reach them.
 */
export function registerPushRoutes(app, deps) {
  const {
    auth,
    pushDispatchService,
    getPushVapidPublicKey,
  } = deps;

  app.get('/api/push/vapid-public-key', auth, (req, res) => {
    const publicKey = String(getPushVapidPublicKey() || '').trim();
    if (!publicKey) return res.status(503).json({ error: 'Push is not configured' });
    res.json({ publicKey });
  });

  app.get('/api/push/devices', auth, (req, res) => {
    res.json({ devices: pushDispatchService.listDevices() });
  });

  app.post('/api/push/subscribe', auth, (req, res) => {
    const { deviceId, label, subscription, preferences } = req.body || {};
    const endpoint = String(subscription?.endpoint || '').trim();
    const keys = subscription?.keys && typeof subscription.keys === 'object' ? subscription.keys : null;
    if (!String(deviceId || '').trim() || !endpoint || !keys?.p256dh || !keys?.auth) {
      return res.status(400).json({ error: 'Missing deviceId or subscription' });
    }
    const result = pushDispatchService.upsertSubscription({
      deviceId,
      label,
      endpoint,
      keys,
      preferences,
      userAgent: req.headers['user-agent'] || null,
    });
    if (!result.ok) return res.status(400).json({ error: result.error || 'Invalid subscription' });
    res.json({ device: result.device });
  });

  app.patch('/api/push/devices/:id', auth, (req, res) => {
    const { label, preferences } = req.body || {};
    if (label === undefined && preferences === undefined) {
      return res.status(400).json({ error: 'Nothing to update' });
    }
    const result = pushDispatchService.updateDevice(req.params.id, { label, preferences });
    if (!result.ok) return res.status(404).json({ error: result.error || 'Not found' });
    res.json({ device: result.device });
  });

  app.delete('/api/push/devices/:id', auth, (req, res) => {
    const result = pushDispatchService.deleteDevice(req.params.id);
    if (!result.ok) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  });
}
