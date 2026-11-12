/**
 * The environment of a scratch relay: one started by hand or by a script (the
 * mixed-version and pairing runs) rather than by the e2e runner.
 *
 * tests/relay-server-harness.mjs lays out the state root and pins every
 * home-derived path; this helper puts those pins over an environment built
 * from nothing instead of the host's, so a scratch relay can reach none of
 * the host's state:
 *
 *  - its own state root, data folder (`COPILOT_WEB_RELAY_DATA_DIR`), config
 *    (`COPILOT_WEB_RELAY_CONFIG`, written with its own port) and port;
 *  - `HOME`, `USERPROFILE`, `APPDATA`, `LOCALAPPDATA` and the temp folder
 *    inside the state root;
 *  - nothing inherited from `COPILOT_*` (`COPILOT_WEB_RELAY_*`,
 *    `COPILOT_SESSION_STATE_DIR`), `OAR_*`, `ANTHROPIC_*`, `CLAUDE_*`,
 *    `OPENAI_*`, `GITHUB_*`, `GH_*`, `XAI_*`, `DEEPSEEK_*` or `CURSOR_*`:
 *    only the harness's own pins and the caller's `overrides` carry them;
 *  - `PATH` reduced to node and the system folders. On POSIX node is reached
 *    through a link inside the state root, because node's own folder is
 *    where a global npm install puts the agent CLIs.
 *
 * No agent CLI may start under it (`COPILOT_WEB_RELAY_DISABLE_CLI_SPAWN`,
 * from the harness). A script lists the relay's child processes while it
 * runs (`scratchRelayDescendants`) and checks after stopping it that none
 * is left (`stillRunning`).
 */

import fs from "node:fs";
import path from "node:path";

import {
  buildRelayServerEnv,
  createStateRoot,
  removeStateRoot,
  repoRoot,
  reserveFreePort,
} from "../relay-server-harness.mjs";
import { createProcessLister } from "../../server/services/process-list-service.mjs";
import { collectProcessDescendants } from "../../shared/worker-runtime/process-tree.mjs";

export const SCRATCH_RELAY_FORBIDDEN_ENV = /^(COPILOT_|OAR_|ANTHROPIC_|CLAUDE_|OPENAI_|GITHUB_|GH_|XAI_|DEEPSEEK_|CURSOR_)/;

// What a scratch relay takes from the host as it is: the locale, the time
// zone and, on Windows, what any process there needs to start at all.
const PASSED_THROUGH = ["LANG", "LC_ALL", "TZ"];
const PASSED_THROUGH_WIN32 = ["SystemRoot", "SystemDrive", "windir", "ComSpec", "PATHEXT"];

function reducedPath(stateRoot, { platform, execPath, hostEnv }) {
  if (platform === "win32") {
    const systemRoot = hostEnv.SystemRoot || "C:\\Windows";
    return [path.dirname(execPath), path.join(systemRoot, "System32"), systemRoot, path.join(systemRoot, "System32", "Wbem")].join(";");
  }
  const nodeBin = path.join(stateRoot, "node-bin");
  let nodeDir = nodeBin;
  try {
    fs.mkdirSync(nodeBin, { recursive: true });
    fs.symlinkSync(execPath, path.join(nodeBin, "node"));
  } catch {
    nodeDir = path.dirname(execPath);
  }
  return [nodeDir, "/usr/bin", "/bin"].join(":");
}

function baseEnvOf(paths, { platform, execPath, hostEnv }) {
  const temp = path.join(paths.stateRoot, "tmp");
  const appData = path.join(paths.stateRoot, "AppData", "Roaming");
  fs.mkdirSync(temp, { recursive: true });
  fs.mkdirSync(appData, { recursive: true });
  const env = {};
  for (const key of [...PASSED_THROUGH, ...(platform === "win32" ? PASSED_THROUGH_WIN32 : [])]) {
    if (hostEnv[key] !== undefined) env[key] = hostEnv[key];
  }
  return {
    ...env,
    PATH: reducedPath(paths.stateRoot, { platform, execPath, hostEnv }),
    TEMP: temp,
    TMP: temp,
    TMPDIR: temp,
    APPDATA: appData,
  };
}

/** The pins this helper sets itself (the keys of an environment it builds over nothing). */
function ownKeys(overrides = {}) {
  const fake = Object.fromEntries(["stateRoot", "dataDir", "claudeConfigDir", "claudeCredFile", "sdkStubDir", "cliBinDir", "localAppDataDir", "grokAuthFile", "grokLoginAuthorizedFile", "grokLoginDeniedFile"].map((key) => [key, key]));
  return new Set([
    ...Object.keys(buildRelayServerEnv({ ...fake, baseEnv: {} })),
    "COPILOT_WEB_RELAY_ROOT",
    "COPILOT_WORKSPACE_ROOT",
    ...Object.keys(overrides),
  ]);
}

/**
 * The provider, relay and OAR variables in `env` that neither this helper
 * nor the caller's `overrides` set: each one leaked in from the host.
 */
export function inheritedEnvKeys(env, { overrides = {} } = {}) {
  const own = ownKeys(overrides);
  return Object.keys(env || {}).filter((key) => SCRATCH_RELAY_FORBIDDEN_ENV.test(key) && !own.has(key));
}

/**
 * A fresh state root, port and environment for one scratch relay.
 *
 * - `root`: the checkout or unpacked build the relay runs from (its
 *   `server/server.js`); this one by default.
 * - `port`: a free one by default.
 * - `config`: more config keys. `authToken` belongs here only for a build
 *   from before agent auth, which read its token from the config.
 * - `overrides`: env keys set last, on purpose (a stub URL, an un-pinned flag).
 *
 * Returns `{ env, port, baseUrl, serverScript, stateRoot, dataDir,
 * configPath, cleanup() }`. Nothing here prints or logs the config.
 */
export async function createScratchRelayEnv({
  root = repoRoot,
  port = null,
  config = {},
  overrides = {},
  hostEnv = process.env,
  platform = process.platform,
  execPath = process.execPath,
} = {}) {
  const resolvedPort = port || await reserveFreePort();
  const paths = createStateRoot();
  try {
    const configPath = path.join(paths.stateRoot, "config.json");
    let existing = {};
    try { existing = JSON.parse(fs.readFileSync(configPath, "utf8")); } catch {}
    fs.writeFileSync(
      configPath,
      `${JSON.stringify({ ...existing, ...config, port: resolvedPort, localhostOnly: true }, null, 2)}\n`,
      { mode: 0o600 },
    );
    const env = buildRelayServerEnv({
      ...paths,
      baseEnv: baseEnvOf(paths, { platform, execPath, hostEnv }),
      overrides: {
        COPILOT_WEB_RELAY_ROOT: root,
        // Its sessions' default folder: inside the state root, never a checkout.
        COPILOT_WORKSPACE_ROOT: paths.stateRoot,
        ...overrides,
      },
    });
    const leaked = inheritedEnvKeys(env, { overrides });
    if (leaked.length) throw new Error(`scratch relay env inherits ${leaked.join(", ")}`);
    return {
      env,
      port: resolvedPort,
      baseUrl: `http://127.0.0.1:${resolvedPort}`,
      serverScript: path.join(root, "server", "server.js"),
      stateRoot: paths.stateRoot,
      dataDir: paths.dataDir,
      configPath,
      cleanup: () => removeStateRoot(paths.stateRoot),
    };
  } catch (error) {
    removeStateRoot(paths.stateRoot);
    throw error;
  }
}

/**
 * The processes below `pid` now, `{ processId, ... }`. Read it while the
 * relay runs: on POSIX a process whose parent ended is moved under init.
 */
export async function scratchRelayDescendants(pid, { lister = createProcessLister() } = {}) {
  return collectProcessDescendants(await lister.list(), { processId: Number(pid), createdAt: 0 });
}

/** Those of `processes` still running (after the relay was stopped, none should be). */
export function stillRunning(processes, { signal = process.kill } = {}) {
  return (Array.isArray(processes) ? processes : []).filter((proc) => {
    try {
      signal(Number(proc.processId), 0);
      return true;
    } catch (error) {
      return error?.code === "EPERM";
    }
  });
}
