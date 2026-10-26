// The CLI's routing and trust variables a chat folder's settings must not
// set, shared by the backends that run Claude Code on a key of the relay's
// (DeepSeek, Claude API): each pins them in its live flag settings. And the
// settings both spawn the CLI with: no hooks (CLAUDE_CLI_KEY_CHAT_SETTINGS).
//
// The list comes from the bundled CLI and only from it. On every SDK or CLI
// bump, re-run both proofs (scripts/deepseek-cli-proof.mjs,
// scripts/claude-api-cli-proof.mjs) and the env-name grep over that binary
// (fixed names, grep -a, under timeout and nice; never a regex over the
// whole binary), and update the list and its source line below.

/**
 * Every variable through which the env of the chat folder's settings
 * (.claude/settings.json, settings.local.json) could send the CLI's requests,
 * and with them the key, somewhere else, or change whom the CLI trusts on the
 * way: the endpoints, the provider switches, the credentials, the proxies and
 * the TLS trust. The DeepSeek and the Claude API backends pin each one in
 * their live flag settings (liveFlagSettings), which the CLI applies over the
 * folder's, to the value the CLI was spawned with: the worker's own, else the
 * other case's for a proxy variable, else ''.
 * '' is unset to the CLI for each of these (truthy or trimmed reads), except
 * SSL_CERT_FILE and SSL_CERT_DIR: '' empties OpenSSL's and Node's system
 * store, so those two are pinned only when the worker sets them.
 *
 * Source: the names Claude Code 2.1.304 (the bundled CLI) reads, by a grep
 * of the binary; the CLI's own lists of endpoints (with their selection
 * switches and companions) and credentials are in it as they are there. A
 * deny-list, because a settings layer can only pin names known in advance.
 * Left out, each for its reason: the model variables (same endpoint, same
 * key), what the CLI already drops from a folder's settings or from all
 * settings (CLAUDE_CONFIG_DIR, CLAUDE_CODE_CUSTOM_OAUTH_URL, the OTEL
 * exporter endpoints, ANTHROPIC_UNIX_SOCKET, the host-managed provider
 * switches, the file-descriptor credentials), a provider's own SDK settings
 * (AWS_*, GOOGLE_*, AZURE_*, read only for the provider the switches here
 * turn off), NODE_OPTIONS (at runtime the CLI reads only its system-CA
 * flags, which add no CA), and what routes only other programs' traffic
 * (NPM_CONFIG_*, GIT_*, the resolver's variables).
 */
export const CLAUDE_CLI_PINNED_ENV = Object.freeze([
  // Endpoints: the CLI's list, its fallback and the headers sent with them.
  'ANTHROPIC_BASE_URL',
  '_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL',
  'ANTHROPIC_CUSTOM_HEADERS',
  'ANTHROPIC_BEDROCK_BASE_URL',
  'ANTHROPIC_VERTEX_BASE_URL',
  'ANTHROPIC_FOUNDRY_BASE_URL',
  'ANTHROPIC_AWS_BASE_URL',
  'ANTHROPIC_GOOGLE_CLOUD_BASE_URL',
  'ANTHROPIC_BEDROCK_MANTLE_BASE_URL',
  'CLAUDE_CODE_API_BASE_URL',
  'CLAUDE_CODE_ARTIFACTS_API_BASE_URL',
  'CLAUDE_CODE_ARTIFACTS_API_TOKEN',
  'CLAUDE_CODE_ARTIFACT_ASSET_BASE_URL',
  'CLAUDE_CODE_ARTIFACT_LIVE_BASE_URL',
  'CLAUDE_CODE_ARTIFACT_SYNC_BASE_URL',
  'CLAUDE_CODE_ARTIFACT_VIEWER_BASE_URL',
  'CLAUDE_CODE_MEMORY_API_BASE_URL',
  'CLAUDE_CODE_MEMORY_API_TOKEN',
  // Provider switches.
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_ANTHROPIC_AWS',
  'CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD',
  'CLAUDE_CODE_USE_MANTLE',
  'CLAUDE_CODE_USE_GATEWAY',
  'CLAUDE_CODE_SKIP_BEDROCK_AUTH',
  'CLAUDE_CODE_SKIP_VERTEX_AUTH',
  'CLAUDE_CODE_SKIP_FOUNDRY_AUTH',
  'CLAUDE_CODE_SKIP_ANTHROPIC_AWS_AUTH',
  'CLAUDE_CODE_SKIP_ANTHROPIC_GOOGLE_CLOUD_AUTH',
  'CLAUDE_CODE_SKIP_MANTLE_AUTH',
  // Credentials: the CLI's list, the OAuth login, the federation profile and
  // the proxy credential helper.
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'AWS_BEARER_TOKEN_BEDROCK',
  'ANTHROPIC_FOUNDRY_API_KEY',
  'ANTHROPIC_FOUNDRY_AUTH_TOKEN',
  'ANTHROPIC_AWS_API_KEY',
  'CLAUDE_CODE_OAUTH_REFRESH_TOKEN',
  'CLAUDE_CODE_OAUTH_SCOPES',
  'CLAUDE_CODE_OAUTH_CLIENT_ID',
  'ANTHROPIC_PROFILE',
  'ANTHROPIC_IDENTITY_TOKEN',
  'ANTHROPIC_IDENTITY_TOKEN_FILE',
  'ANTHROPIC_FEDERATION_RULE_ID',
  'ANTHROPIC_ORGANIZATION_ID',
  'ANTHROPIC_SERVICE_ACCOUNT_ID',
  'ANTHROPIC_SCOPE',
  'ANTHROPIC_WORKSPACE_ID',
  'CLAUDE_CODE_ENABLE_PROXY_AUTH_HELPER',
  // Proxies: the CLI reads both cases, the lower one first.
  'HTTPS_PROXY',
  'https_proxy',
  'HTTP_PROXY',
  'http_proxy',
  'ALL_PROXY',
  'all_proxy',
  'NO_PROXY',
  'no_proxy',
  'CLAUDE_CODE_HTTPS_PROXY',
  'CLAUDE_CODE_HTTP_PROXY',
  // TLS trust and the client certificate.
  'NODE_TLS_REJECT_UNAUTHORIZED',
  'NODE_EXTRA_CA_CERTS',
  'CLAUDE_CODE_CERT_STORE',
  'CLAUDE_CODE_CLIENT_CERT',
  'CLAUDE_CODE_CLIENT_KEY',
  'CLAUDE_CODE_CLIENT_KEY_PASSPHRASE',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
]);
// The two of CLAUDE_CLI_PINNED_ENV for which '' is not unset (see there).
const PINNED_ONLY_WHEN_SET = new Set(['SSL_CERT_FILE', 'SSL_CERT_DIR']);
// The proxy variables the CLI and the tools it runs read in either case.
const OTHER_CASE = new Map(
  ['HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'NO_PROXY'].flatMap((name) => [
    [name, name.toLowerCase()],
    [name.toLowerCase(), name],
  ]),
);

/**
 * The settings both backends spawn every CLI with, on its command line (their
 * flagSettings): no hooks and no statusLine command, neither the user's nor
 * the chat folder's nor a plugin's. Those run as the relay's user with the
 * CLI's environment, the key in it, and a folder's SessionStart hook would run
 * before the live pins land. The SDK has the spawn settings in force before
 * any hook (sdk.d.ts, Options.settings; scripts/claude-cli-hooks-proof.mjs
 * shows it). Hooks in managed settings still run: those are the host admin's.
 * OAR's Claude worker registers no SDK hooks of its own.
 */
export const CLAUDE_CLI_KEY_CHAT_SETTINGS = Object.freeze({ disableAllHooks: true });

/**
 * The pins of CLAUDE_CLI_PINNED_ENV for a CLI spawned with `cliEnv`: the
 * value it was spawned with, else the other case's (a proxy the worker sets
 * as https_proxy holds for HTTPS_PROXY as well), else ''.
 */
export function claudeCliPinnedEnv(cliEnv = {}) {
  const pins = {};
  for (const name of CLAUDE_CLI_PINNED_ENV) {
    const own = cliEnv[name] ?? cliEnv[OTHER_CASE.get(name)];
    if (own !== undefined) pins[name] = String(own);
    else if (!PINNED_ONLY_WHEN_SET.has(name)) pins[name] = '';
  }
  return pins;
}
