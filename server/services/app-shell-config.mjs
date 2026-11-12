'use strict';

// The `window.__COPILOT_APP_CONFIG = {…};` line the relay writes into the app
// shell (index.html) before it is served. Its values reach a <script> element
// as code: the JSON is escaped so that no value (the relay name is the
// person's free text) can close the element or start another one, and the
// line goes in through a replacer function, so `$&` and friends in a value are
// not read as replacement patterns.

const SCRIPT_UNSAFE = /[<>&\u2028\u2029]/g;

function escapeChar(char) {
  return `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`;
}

/** JSON that is safe inside an inline <script>. */
export function scriptSafeJson(value) {
  return JSON.stringify(value).replace(SCRIPT_UNSAFE, escapeChar);
}

/** `source` with the config placeholder replaced by `config`. */
export function injectAppConfig(source, placeholder, config) {
  const line = `window.__COPILOT_APP_CONFIG = ${scriptSafeJson(config)};`;
  return String(source).replace(placeholder, () => line);
}
