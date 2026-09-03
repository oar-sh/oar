import fs from 'fs';
import path from 'path';

/**
 * Where the relay's database (and lock) live, decided before anything else
 * touches disk.
 *
 * Precedence: the COPILOT_WEB_RELAY_DATA_DIR env var (launchers and the e2e
 * harness pin it), then a `dataDir` key in config.json, then the server
 * directory's own `data/`. The config key exists so an instance's identity —
 * including where its data lives — travels entirely inside config.json: a
 * dev checkout can point at a release install's data dir (the singleton
 * guard's lock lives inside the data dir, so two relays sharing one refuse
 * to run concurrently), and a regenerated autostart launcher only has to pin
 * the config path to reproduce the whole instance.
 *
 * A relative `dataDir` resolves against the config file's directory, not the
 * process cwd — the same config must mean the same data dir no matter where
 * the server was launched from.
 */
export function resolveDataDir({
  env = process.env,
  configPath,
  serverDir,
  fsImpl = fs,
  pathImpl = path,
} = {}) {
  const fromEnv = String(env?.COPILOT_WEB_RELAY_DATA_DIR || '').trim();
  if (fromEnv) return pathImpl.resolve(fromEnv);

  const resolvedConfigPath = String(configPath || '').trim();
  if (resolvedConfigPath) {
    let parsed = null;
    try {
      parsed = JSON.parse(fsImpl.readFileSync(resolvedConfigPath, 'utf8'));
    } catch {
      // Unreadable/absent/invalid config falls through to the default; the
      // runtime reports config problems itself when it loads the file.
    }
    const fromConfig = String(parsed?.dataDir || '').trim();
    if (fromConfig) {
      return pathImpl.resolve(pathImpl.dirname(resolvedConfigPath), fromConfig);
    }
  }

  return pathImpl.join(String(serverDir || ''), 'data');
}
