'use strict';

// GET /api/about: the About OAR modal's data (about-service.mjs). The owner's
// only; a shared viewer never sees it.

export function registerAboutRoutes(app, { auth, aboutService = null } = {}) {
  app.get('/api/about', auth, async (_req, res) => {
    if (!aboutService) return res.status(503).json({ error: 'About is unavailable on this relay' });
    try {
      return res.json(await aboutService.describe());
    } catch (error) {
      return res.status(500).json({ error: `Reading the relay's facts failed: ${String(error?.message || error)}` });
    }
  });
}
