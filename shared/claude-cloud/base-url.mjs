// Where the cloud client sends its calls.
//
// Always the Anthropic API, with one exception for tests: the environment
// variable below may point the client at a fake API on the same machine. The
// client sends the Claude login as a bearer token to whatever its base URL
// is, so an environment variable must never be able to name another host: a
// value that is not a plain http(s) URL of the loopback interface is ignored
// and the default stays. The relay's client and the cloud worker's both ask
// here, so the rule lives in this one function.

import { CLAUDE_CLOUD_BASE_URL } from './api-client.mjs';

export const CLAUDE_CLOUD_BASE_URL_ENV = 'OAR_CLAUDE_CLOUD_API_BASE_URL';

// Exactly these, as the URL parser writes them (it lower-cases the name and
// puts the IPv6 address in brackets). No "anything in 127/8", no trailing dot,
// no name that merely starts or ends like one of them.
const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', '[::1]', 'localhost']);

/**
 * The origin of a loopback http(s) URL (`http://127.0.0.1:4010`), or null for
 * anything else: another host, another scheme, a URL with a user or a
 * password in it, or text that is no URL at all. A path, query or fragment is
 * dropped: the client's routes start at the root.
 */
export function loopbackBaseUrlOrNull(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return null;
  let url;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username || url.password) return null;
  if (!LOOPBACK_HOSTNAMES.has(url.hostname)) return null;
  return url.origin;
}

/**
 * The base URL for `createClaudeCloudClient`: the loopback URL named by
 * `OAR_CLAUDE_CLOUD_API_BASE_URL`, else the Anthropic API.
 */
export function resolveClaudeCloudBaseUrl(env = process.env) {
  return loopbackBaseUrlOrNull(env?.[CLAUDE_CLOUD_BASE_URL_ENV]) || CLAUDE_CLOUD_BASE_URL;
}
