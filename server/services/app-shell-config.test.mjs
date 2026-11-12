import test from 'node:test';
import assert from 'node:assert/strict';

import { injectAppConfig, scriptSafeJson } from './app-shell-config.mjs';

const PLACEHOLDER = /window\.__COPILOT_APP_CONFIG = \{ basePath: '[^']*' \};/;
const SHELL = "<script>\n  window.__COPILOT_APP_CONFIG = { basePath: '' };\n</script>";

test('the relay name goes into the shell as data: it cannot close the script element', () => {
  const html = injectAppConfig(SHELL, PLACEHOLDER, { basePath: '', relayName: '</script><script>alert(1)</script>' });
  assert.equal(html.match(/<\/script>/g).length, 1, 'only the shell\'s own closing tag');
  assert.equal(html.includes('<script>alert'), false);
  const line = html.split('\n')[1];
  // Run as the browser would: the value comes back as written.
  const window = {};
  new Function('window', line)(window);
  assert.equal(window.__COPILOT_APP_CONFIG.relayName, '</script><script>alert(1)</script>');
});

test('replacement patterns in a value are kept as text', () => {
  const html = injectAppConfig(SHELL, PLACEHOLDER, { basePath: '/oar', relayName: "desk $& $' $1" });
  const window = {};
  new Function('window', html.split('\n')[1])(window);
  assert.deepEqual(window.__COPILOT_APP_CONFIG, { basePath: '/oar', relayName: "desk $& $' $1" });
});

test('line and paragraph separators are escaped', () => {
  assert.equal(scriptSafeJson('a\u2028b\u2029c'), '"a\\u2028b\\u2029c"');
  assert.equal(scriptSafeJson({ a: '<&>' }), '{"a":"\\u003c\\u0026\\u003e"}');
});
