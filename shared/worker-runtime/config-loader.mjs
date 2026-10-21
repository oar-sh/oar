import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { RESCUE_DIR_NAME } from "../../server/services/earlier-database-service.mjs";
import { resolveRelayStateDirs, resolveStateLayout } from "../../server/services/oar-state-layout.mjs";

function toAbsolutePath(value) {
  if (!value) return "";
  return path.isAbsolute(value) ? value : path.resolve(process.cwd(), value);
}

function looksLikeServerDir(serverDir) {
  if (!serverDir) return false;
  return fs.existsSync(path.join(serverDir, "server.js")) && fs.existsSync(path.join(serverDir, "config.json"));
}

/**
 * Where the extension finds the relay, its config and logs. A global install
 * uses the state root's folders as `oar start` does, and `RELAY_ENV` pins
 * them for the managed relay (not `server/data`, which `npm i -g` deletes).
 * The environment wins; a checkout keeps its `server/` folders.
 */
export function resolveRelayPaths(importMetaUrl, { env = process.env, platform = process.platform } = {}) {
  const __dirname = path.dirname(fileURLToPath(importMetaUrl));
  const projectServerDir = path.resolve(__dirname, "../../../server");
  const cwdServerDir = path.resolve(process.cwd(), "server");
  const envRoot = toAbsolutePath(env.COPILOT_WEB_RELAY_ROOT || "");
  const envServerDir = toAbsolutePath(env.COPILOT_WEB_RELAY_SERVER_DIR || "");
  const envConfigPath = toAbsolutePath(env.COPILOT_WEB_RELAY_CONFIG || "");
  const envToolsPath = toAbsolutePath(env.COPILOT_WEB_RELAY_TOOLS || "");
  const envLogDir = toAbsolutePath(env.COPILOT_WEB_RELAY_LOG_DIR || "");

  const resolvedServerDir =
    (looksLikeServerDir(envServerDir) && envServerDir) ||
    (looksLikeServerDir(path.join(envRoot, "server")) && path.join(envRoot, "server")) ||
    (looksLikeServerDir(projectServerDir) && projectServerDir) ||
    (looksLikeServerDir(cwdServerDir) && cwdServerDir) ||
    projectServerDir;

  const SERVER_DIR = resolvedServerDir;
  const packageRoot = path.dirname(SERVER_DIR);
  const layout = resolveStateLayout({ packageRoot, env, platform });
  const stateDirs = layout.checkout ? null : resolveRelayStateDirs({ packageRoot, env, platform, layout });
  const CONFIG_PATH = envConfigPath
    || (stateDirs ? path.join(layout.configDir, "config.json") : path.resolve(SERVER_DIR, "config.json"));
  const RELAY_TOOLS_PATH = envToolsPath || path.resolve(SERVER_DIR, "relay-tools.md");
  const LOG_DIR = envLogDir || stateDirs?.logDir || path.resolve(SERVER_DIR, "logs");
  const SERVER_LOG_PATH = path.resolve(LOG_DIR, "server.log");
  const SERVER_ERR_PATH = path.resolve(LOG_DIR, "server-err.log");
  const RELAY_ENV = stateDirs
    ? {
      COPILOT_WEB_RELAY_ROOT: packageRoot,
      COPILOT_WEB_RELAY_CONFIG: CONFIG_PATH,
      COPILOT_WEB_RELAY_DATA_DIR: stateDirs.dataDir,
      COPILOT_WEB_RELAY_LOG_DIR: LOG_DIR,
    }
    : {};

  return {
    __dirname,
    CONFIG_PATH,
    RELAY_TOOLS_PATH,
    SERVER_DIR,
    LOG_DIR,
    SERVER_LOG_PATH,
    SERVER_ERR_PATH,
    RELAY_ENV,
  };
}

/**
 * The package's `server/config.json` (or the newest rescued one) copied to the
 * state root when it has none: copy only, never over one. Returns the source.
 */
export function carryOverPackageConfig({ serverDir, configPath, dataDir, fsImpl = fs } = {}) {
  if (!configPath || !dataDir || fsImpl.existsSync(configPath)) return null;
  const sources = [path.join(serverDir, "config.json")];
  try {
    const rescueRoot = path.join(dataDir, RESCUE_DIR_NAME);
    for (const name of fsImpl.readdirSync(rescueRoot).filter((entry) => !entry.endsWith(".partial")).sort().reverse()) {
      sources.push(path.join(rescueRoot, name, "config.json"));
    }
  } catch {}
  const source = sources.find((file) => fsImpl.existsSync(file));
  if (!source) return null;
  try {
    fsImpl.mkdirSync(path.dirname(configPath), { recursive: true });
    fsImpl.copyFileSync(source, configPath, fs.constants.COPYFILE_EXCL);
    return source;
  } catch {
    return null;
  }
}

export function loadTokenFromConfig(configPath) {
  try {
    const cfg = loadRelayConfig(configPath);
    return String(cfg.authToken || "").trim();
  } catch {
    return "";
  }
}

export function loadRelayConfig(configPath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function normalizeLoopbackHost(value) {
  const host = String(value || "").trim();
  if (!host || host === "0.0.0.0" || host === "::") return "127.0.0.1";
  if (host === "localhost") return "127.0.0.1";
  return host;
}

export function resolveRelayServerUrl({ configPath, env = process.env } = {}) {
  const explicitUrl = String(env.COPILOT_WEB_RELAY_SERVER_URL || "").trim();
  if (explicitUrl) {
    const url = new URL(explicitUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error(`invalid-relay-server-url:${url.protocol}`);
    }
    url.pathname = "";
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  }

  const config = loadRelayConfig(configPath);
  const configuredPort = Number.parseInt(String(config.port || ""), 10);
  const port = Number.isInteger(configuredPort) && configuredPort > 0 && configuredPort <= 65535
    ? configuredPort
    : 3333;
  const host = normalizeLoopbackHost(config.host);
  const formattedHost = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `http://${formattedHost}:${port}`;
}

export function loadRelayInstructionsFromFile(relayToolsPath) {
  try {
    return String(fs.readFileSync(relayToolsPath, "utf8")).trim();
  } catch {
    return "";
  }
}
