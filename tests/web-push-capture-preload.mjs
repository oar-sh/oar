// A spec's stand-in for the push service (loaded with `node --import` into a
// test relay, see webPushCaptureOverrides): with RELAY_E2E_PUSH_CAPTURE set,
// the relay's web-push sender writes each notification payload it would send
// to that file, one JSON line per push, and sends nothing. The relay renders
// and dispatches as it always does; only the network call is replaced.

import fs from 'node:fs';
import { createRequire } from 'node:module';

const captureFile = String(process.env.RELAY_E2E_PUSH_CAPTURE || '').trim();
if (captureFile) {
  const require = createRequire(new URL('../package.json', import.meta.url));
  // The CommonJS module object the server's `import webpush from 'web-push'` gets too.
  const webpush = require('web-push');
  webpush.sendNotification = async (subscription, payload) => {
    fs.appendFileSync(captureFile, `${JSON.stringify({ endpoint: subscription?.endpoint || '', payload: JSON.parse(String(payload || 'null')) })}\n`);
    return { statusCode: 201, body: '', headers: {} };
  };
}
