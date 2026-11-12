/**
 * npm from its cache first, for the packed-update test: `npm cache add` of
 * the SDK pins, the global installs, and (through npm-ci-online-retry.mjs)
 * the relays' SDK store installs. A packument npm cached before a version
 * was published says that version does not exist, and `--prefer-offline`
 * (or npm_config_prefer_offline) believes it: npm fails with ETARGET ("No
 * matching version found"). Once, then, the run is repeated online
 * (`--prefer-online`, the offline preference dropped), which fetches the
 * packument again. Any other failure is the caller's.
 *
 * `npm(args, options)` runs npm and rejects with an error whose `output` (or
 * message) holds what npm printed.
 */
export const NPM_ETARGET = /\bETARGET\b/;

const PREFER_OFFLINE_ENV = /^npm_config_prefer_offline$/i;

/** `args` for the online repeat: `--prefer-offline` becomes `--prefer-online` (added when absent). */
export function onlineNpmArgs(args) {
  const list = Array.from(args || []);
  const at = list.indexOf("--prefer-offline");
  if (at >= 0) list.splice(at, 1, "--prefer-online");
  else if (!list.includes("--prefer-online")) list.push("--prefer-online");
  return list;
}

/** `options` for the online repeat: the environment without npm_config_prefer_offline. */
export function onlineNpmOptions(options = {}) {
  if (!options?.env) return options;
  const env = Object.fromEntries(Object.entries(options.env).filter(([key]) => !PREFER_OFFLINE_ENV.test(key)));
  return { ...options, env };
}

/** Runs `npm(args, options)`; on ETARGET, once more online. */
export async function npmPreferringOffline(npm, args, options = {}) {
  try {
    return await npm(args, options);
  } catch (error) {
    if (!NPM_ETARGET.test(String(error?.output || error?.message || ""))) throw error;
    return npm(onlineNpmArgs(args), onlineNpmOptions(options));
  }
}

export function addToNpmCache(npm, specs, options = {}) {
  return npmPreferringOffline(npm, ["cache", "add", "--prefer-offline", ...specs], options);
}
