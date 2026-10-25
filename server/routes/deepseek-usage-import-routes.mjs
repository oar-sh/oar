'use strict';

// POST /api/deepseek-usage-import: the two CSV files of DeepSeek's usage
// export, as text, from Settings → Providers → DeepSeek. The relay's user
// only: another relay's agent gets a 403. The import itself is in
// services/deepseek-usage-import.mjs.

import { readRemoteRelayRequest } from '../services/remote-relay-inbound.mjs';

// The two files of a month come to well under a megabyte.
export const DEEPSEEK_USAGE_IMPORT_MAX_BYTES = 2 * 1024 * 1024;

// How long the import waits for the usage card's currency (the balance's).
export const DEEPSEEK_USAGE_IMPORT_CURRENCY_WAIT_MS = 5000;

/**
 * @param {object} deps
 * @param {Function} [deps.getCardCurrency] the usage card's currency ('USD',
 *   'CNY'), from the balance; may be async. The summary then says whether
 *   the card can use the export's rows.
 * @param {Function} [deps.logError] where a failed import is logged
 */
export function registerDeepSeekUsageImportRoutes(app, deps) {
  const {
    auth,
    deepseekUsageImportService,
    remoteRelayInbound,
    getCardCurrency = null,
    logError = (message, err) => console.error(message, err),
  } = deps;

  async function cardCurrency() {
    if (typeof getCardCurrency !== 'function') return null;
    let timer = null;
    try {
      return await Promise.race([
        Promise.resolve().then(() => getCardCurrency()),
        new Promise((resolve) => { timer = setTimeout(() => resolve(null), DEEPSEEK_USAGE_IMPORT_CURRENCY_WAIT_MS); }),
      ]);
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  app.post('/api/deepseek-usage-import', auth, async (req, res) => {
    if (readRemoteRelayRequest(req, remoteRelayInbound || {}).remote) {
      return res.status(403).json({ error: 'The DeepSeek usage export is imported by this relay\'s user only.' });
    }
    if (typeof deepseekUsageImportService?.importExport !== 'function') {
      return res.status(501).json({ error: 'The DeepSeek usage import is not available on this relay.' });
    }
    const amount = req.body?.amount;
    const cost = req.body?.cost;
    if (typeof amount !== 'string' || typeof cost !== 'string') {
      return res.status(400).json({ error: 'Choose both files of the export: the amount file and the cost file.' });
    }
    if (Buffer.byteLength(amount, 'utf8') + Buffer.byteLength(cost, 'utf8') > DEEPSEEK_USAGE_IMPORT_MAX_BYTES) {
      return res.status(413).json({ error: 'The files are larger than 2 MB together; export a shorter period.' });
    }
    let result;
    try {
      result = deepseekUsageImportService.importExport({ amount, cost, cardCurrency: await cardCurrency() });
    } catch (err) {
      logError('[deepseek-usage-import] the import failed:', err);
      return res.status(500).json({ error: 'The import failed on the relay; nothing was imported. Its log has the reason.' });
    }
    if (!result?.ok) return res.status(400).json({ error: result?.error || 'The export could not be read.' });
    res.json({ ok: true, summary: result.summary });
  });
}
