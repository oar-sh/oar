import assert from 'node:assert/strict';
import test from 'node:test';

import { CLAUDE_CLI_KEY_CHAT_SETTINGS, CLAUDE_CLI_PINNED_ENV, claudeCliPinnedEnv } from './claude-cli-pinned-env.mjs';

test('the key chats\' spawn settings turn every hook and the status line off, and are frozen', () => {
  assert.deepEqual(CLAUDE_CLI_KEY_CHAT_SETTINGS, { disableAllHooks: true });
  assert.equal(Object.isFrozen(CLAUDE_CLI_KEY_CHAT_SETTINGS), true);
});

test('the pinned names cover the routing, trust and credential variables, and the list is frozen', () => {
  assert.equal(Object.isFrozen(CLAUDE_CLI_PINNED_ENV), true);
  assert.equal(new Set(CLAUDE_CLI_PINNED_ENV).size, CLAUDE_CLI_PINNED_ENV.length);
  for (const name of [
    'ANTHROPIC_BASE_URL', 'ANTHROPIC_CUSTOM_HEADERS', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX',
    'CLAUDE_CODE_USE_GATEWAY', 'HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy', 'NO_PROXY',
    'no_proxy', 'NODE_TLS_REJECT_UNAUTHORIZED', 'NODE_EXTRA_CA_CERTS', 'CLAUDE_CODE_CERT_STORE', 'SSL_CERT_FILE',
  ]) assert.ok(CLAUDE_CLI_PINNED_ENV.includes(name), name);
  // Left to the folder: the model choice, and NODE_OPTIONS (see the list).
  for (const name of ['ANTHROPIC_MODEL', 'NODE_OPTIONS', 'CLAUDE_CONFIG_DIR']) assert.equal(CLAUDE_CLI_PINNED_ENV.includes(name), false, name);
});

test('a pin is the CLI\'s own value, else the other case\'s for a proxy, else blank; SSL_CERT_* only when set', () => {
  const pins = claudeCliPinnedEnv({ http_proxy: 'http://127.0.0.1:1', NO_PROXY: 'localhost', SSL_CERT_DIR: '/etc/ssl/certs', NODE_OPTIONS: '--max-old-space-size=512' });
  assert.equal(pins.http_proxy, 'http://127.0.0.1:1');
  assert.equal(pins.HTTP_PROXY, 'http://127.0.0.1:1');
  assert.equal(pins.no_proxy, 'localhost');
  assert.equal(pins.HTTPS_PROXY, '');
  assert.equal(pins.CLAUDE_CODE_USE_BEDROCK, '');
  assert.equal(pins.SSL_CERT_DIR, '/etc/ssl/certs');
  assert.equal('SSL_CERT_FILE' in pins, false);
  assert.equal('NODE_OPTIONS' in pins, false);
  assert.deepEqual(Object.keys(claudeCliPinnedEnv()).sort(), CLAUDE_CLI_PINNED_ENV.filter((name) => !name.startsWith('SSL_CERT_')).sort());
});
