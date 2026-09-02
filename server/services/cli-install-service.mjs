'use strict';
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  CLI_SPAWN_DISABLED_ERROR,
  MAX_CAPTURED_OUTPUT_CHARS,
  isBatchLauncher as isBatchLauncherImpl,
  killTree as killProcessTree,
  quoteForCmd,
  runToCompletion as runProcessToCompletion,
  stripTerminalEscapes,
  tailOf,
} from './cli-process-runner.mjs';

/**
 * Install / update a provider CLI on the relay host, from the web UI.
 *
 * The trigger is a dead end the relay exists to avoid: a Grok turn fails with
 * `relay.grok-cli-missing` and the only fix is a shell on the host. So the
 * vendor one-liners live here as frozen literals, the relay runs them, streams
 * the output, and binds the resulting binary into the worker spawn environment
 * without a restart.
 *
 * Security shape (docs/plans/relay-cli-install-and-grok-auth.md §6):
 * **nothing a caller sends ever reaches a command.** A request body carries a
 * descriptor id and an action name; both are looked up in the frozen table
 * below, and an id that is not in it is a 400 before any spawn is considered.
 * `curl … | bash` is the vendor's own distribution channel — the control that
 * matters is that the URL is a literal in this file.
 *
 * One install at a time, relay-wide (two installers writing `~/.local/bin`
 * concurrently is asking for it):
 *
 *   idle -> running -> success | error | cancelled
 *
 * The three terminal states are *display* states: the session is already
 * released, and the outcome stays readable until the next install or a
 * `cancel()` that resets it to idle.
 */

export const CLI_INSTALL_TIMEOUT_MS = 10 * 60 * 1000;
export const CLI_PROBE_TIMEOUT_MS = 5_000;
export const CLI_STATUS_TTL_MS = 30_000;
// Ceiling on install-log broadcasts: four a second is well under what a live
// log needs to read as live, and far under what a progress-bar installer would
// otherwise push to every connected socket.
export const CLI_INSTALL_LOG_FLUSH_MS = 250;
const KILL_ESCALATION_MS = 2_000;

export const CLI_INSTALL_STATES = Object.freeze({
  IDLE: 'idle',
  RUNNING: 'running',
  SUCCESS: 'success',
  ERROR: 'error',
  CANCELLED: 'cancelled',
});

/** Stand-in for the resolved binary in a descriptor's update/migrate argv. */
const BIN_PLACEHOLDER = '<bin>';

// Last-resort version scrape: every descriptor carries its own pattern, and
// this only runs when that one misses, so a CLI that reworks its --version
// banner degrades to "installed (version unknown)" instead of "not installed"
// (plan risk row 1: every scrape degrades, none of them blocks).
const GENERIC_VERSION_PATTERN = /(\d+\.\d+(?:\.\d+)*)/;

/**
 * The frozen descriptor table: the only place an install command exists.
 *
 * Cursor is deliberately absent — `@cursor/sdk` is a pure npm package and the
 * relay never invokes a `cursor-agent` binary, so an install button there would
 * install a CLI nothing runs (plan §2.4). Adding it back later is a data change
 * here, not a code change.
 *
 * Copilot is present but `detectOnly`: its CLI is npm-global under a prefix the
 * relay user cannot write (plan §2.5), so it reports version and path and
 * offers no buttons. Without the entry its settings sub-tab would be the only
 * one with no CLI row at all.
 */
const CLI_DESCRIPTORS = Object.freeze({
  grok: Object.freeze({
    id: 'grok',
    label: 'Grok CLI',
    binary: 'grok',
    // Bound onto the relay's own environment after a successful install; read
    // by grok-session-worker.mjs and by the ACP model-discovery probe.
    envVar: 'GROK_CLI_COMMAND',
    // The installer lands the binary in ~/.grok/bin and *tries* to symlink it
    // into the first writable ~/.local/bin or /usr/local/bin. All three are
    // searched (and PATH-prepended) so resolution does not depend on which of
    // those happened to be writable.
    extraBinDirs: Object.freeze(['~/.grok/bin', '~/.local/bin', '/usr/local/bin']),
    versionArgs: Object.freeze(['--version']),
    // `grok 1.0.13 (5e9a58528b76) [stable]`
    versionPattern: /grok\s+v?(\d[\w.-]*)/i,
    commands: Object.freeze({
      install: Object.freeze({
        posix: Object.freeze({
          argv: Object.freeze(['bash', '-lc', 'curl -fsSL https://x.ai/cli/install.sh | bash']),
          display: 'curl -fsSL https://x.ai/cli/install.sh | bash',
          targetDir: '~/.grok/bin',
        }),
        win32: Object.freeze({
          argv: Object.freeze(['powershell', '-NoProfile', '-Command', 'irm https://x.ai/cli/install.ps1 | iex']),
          display: 'irm https://x.ai/cli/install.ps1 | iex',
          targetDir: '%USERPROFILE%\\.grok\\bin',
        }),
      }),
      // `installer: "internal"` in the update check: Grok self-updates, so the
      // Update button is never a re-run of the install script.
      update: Object.freeze({
        anyPlatform: Object.freeze({
          argv: Object.freeze([BIN_PLACEHOLDER, 'update']),
          display: 'grok update',
          targetDir: '~/.grok/bin',
        }),
      }),
    }),
    // Machine-readable and exits 0 either way, so the exit code is ignored and
    // only the payload is read.
    checkUpdate: Object.freeze({
      args: Object.freeze(['update', '--check', '--json']),
      parse: (json) => ({
        updateAvailable: json?.updateAvailable === true,
        latestVersion: normalizeText(json?.latestVersion) || null,
      }),
    }),
  }),
  claude: Object.freeze({
    id: 'claude',
    label: 'Claude Code CLI',
    binary: 'claude',
    envVar: 'CLAUDE_CODE_EXECUTABLE',
    extraBinDirs: Object.freeze(['~/.local/bin', '/usr/local/bin']),
    versionArgs: Object.freeze(['--version']),
    // `2.1.251 (Claude Code)`
    versionPattern: /v?(\d[\w.-]*)\s*\(Claude Code\)/i,
    commands: Object.freeze({
      install: Object.freeze({
        posix: Object.freeze({
          argv: Object.freeze(['bash', '-lc', 'curl -fsSL https://claude.ai/install.sh | bash']),
          display: 'curl -fsSL https://claude.ai/install.sh | bash',
          targetDir: '~/.local/bin',
        }),
        win32: Object.freeze({
          argv: Object.freeze(['powershell', '-NoProfile', '-Command', 'irm https://claude.ai/install.ps1 | iex']),
          display: 'irm https://claude.ai/install.ps1 | iex',
          targetDir: '%USERPROFILE%\\.local\\bin',
        }),
      }),
      update: Object.freeze({
        anyPlatform: Object.freeze({
          argv: Object.freeze([BIN_PLACEHOLDER, 'update']),
          display: 'claude update',
          targetDir: '~/.local/bin',
        }),
      }),
      // Anthropic's own prescribed fix for the npm-global-not-writable case
      // `claude doctor` reports (plan §2.3/§5.1): switch to the native build,
      // which takes PATH precedence while the npm copy stays put. Offered by
      // the UI only when the doctor warning is present, never implicitly.
      migrate: Object.freeze({
        anyPlatform: Object.freeze({
          argv: Object.freeze([BIN_PLACEHOLDER, 'install']),
          display: 'claude install',
          targetDir: '~/.local/bin',
        }),
      }),
    }),
    // Read-only, exits 0, and reports install method + path + auto-update
    // health, so the update action is decidable without heuristics.
    doctor: Object.freeze({ args: Object.freeze(['doctor']) }),
  }),
  copilot: Object.freeze({
    id: 'copilot',
    label: 'GitHub Copilot CLI',
    binary: 'copilot',
    envVar: null,
    extraBinDirs: Object.freeze(['~/.local/bin', '/usr/local/bin']),
    versionArgs: Object.freeze(['--version']),
    // `GitHub Copilot CLI 1.0.82.`
    versionPattern: /Copilot CLI\s+v?(\d+\.\d+(?:\.\d+)*)/i,
    detectOnly: true,
    blockedReason: 'Managed with npm on this host — install and update it from a shell.',
    commands: Object.freeze({}),
  }),
});

export const CLI_PROVIDER_IDS = Object.freeze(Object.keys(CLI_DESCRIPTORS));

function normalizeText(value) {
  return String(value == null ? '' : value).trim();
}

/**
 * `claude doctor`, verbatim from a host whose npm global folder is not
 * writable:
 *
 *   Running: npm-global (2.1.247)
 *   Path: /usr/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe
 *   Auto-updates: enabled
 *   Last update attempt: failed (no_permissions) — 2026-08-26
 *   1 warning found
 *   - Can't auto-update: npm global folder isn't writable
 *     Fix: Run claude install to switch to the native installer (no sudo) …
 *
 * Every field is optional: a doctor release that drops or renames a line leaves
 * that field null and the row falls back to the resolved path and `--version`.
 */
export function parseClaudeDoctor(rawOutput) {
  const text = stripTerminalEscapes(rawOutput);
  if (!normalizeText(text)) return null;
  const running = text.match(/^\s*Running:\s*([^\s(]+)\s*(?:\(([^)]*)\))?/m);
  const warnings = [];
  let inWarnings = false;
  for (const line of text.split('\n')) {
    if (/^\s*\d+\s+warnings?\s+found/i.test(line)) {
      inWarnings = true;
      continue;
    }
    if (!inWarnings) continue;
    const bullet = line.match(/^\s*[-*]\s+(\S.*?)\s*$/);
    if (bullet) {
      warnings.push(bullet[1]);
      continue;
    }
    // An indented follow-on line ("  Fix: …") belongs to the warning above it.
    const continuation = line.match(/^\s+(\S.*?)\s*$/);
    if (continuation && warnings.length) {
      warnings[warnings.length - 1] = `${warnings[warnings.length - 1]} ${continuation[1]}`;
    }
  }
  const method = normalizeText(running?.[1]) || null;
  const lastUpdateAttempt = normalizeText(text.match(/^\s*Last update attempt:\s*(.+)$/m)?.[1]) || null;
  const notWritable = /not writable|isn't writable|no_permissions/i.test(
    [...warnings, lastUpdateAttempt || ''].join(' '),
  );
  return {
    method,
    version: normalizeText(running?.[2]) || null,
    path: normalizeText(text.match(/^\s*Path:\s*(.+)$/m)?.[1]) || null,
    autoUpdates: normalizeText(text.match(/^\s*Auto-updates:\s*(.+)$/m)?.[1]) || null,
    lastUpdateAttempt,
    warnings,
    // Pinned as a flag rather than left for the UI to re-derive from prose:
    // this is the one case that gets its own affordance (`claude install`).
    npmGlobalNotWritable: method === 'npm-global' && notWritable,
  };
}

/**
 * File-backed half of the `writeBoundBinaries` seam: merges `cliBinaries` into
 * the relay's config.json and leaves every other key exactly as it was on disk.
 *
 * **A read that fails is never followed by a write.** config.json holds the auth
 * token, the port and the localhost-only flag, and boot deliberately tolerates a
 * config it cannot parse by falling back to defaults (server-runtime.mjs:1540) —
 * so a blind rewrite after a failed read would turn a merely-unparseable file
 * into a valid one containing nothing but `cliBinaries`, and the next boot would
 * mint a fresh auth token and lock out every paired client. A *missing* file is
 * refused for the same reason: recreating it here would recreate it without the
 * token. Losing a CLI binding costs one re-run of the install button; losing the
 * token is not undoable, so the asymmetry decides it.
 *
 * The write itself is tmp-file-then-rename inside the config directory, for the
 * same reason: a crash (or a full disk) part-way through a truncating write
 * leaves a half-written config.json, which is the corrupt-config case above
 * arriving by a different road.
 *
 * Throws on any refusal — the caller keeps the in-memory binding and surfaces
 * the reason (`bindResolvedBinary` logs it), rather than the failure passing
 * silently as a success.
 */
export function writeCliBinariesToConfigFile(configPath, binaries, { fsImpl = fs, pathImpl = path } = {}) {
  const target = normalizeText(configPath);
  if (!target) throw new Error('no config path to persist the CLI binaries into');
  let onDisk = null;
  try {
    onDisk = JSON.parse(fsImpl.readFileSync(target, 'utf8'));
  } catch (error) {
    throw new Error(`refusing to rewrite ${target}: it could not be read (${error?.message || error})`);
  }
  if (!onDisk || typeof onDisk !== 'object' || Array.isArray(onDisk)) {
    throw new Error(`refusing to rewrite ${target}: it does not hold a JSON object`);
  }
  const merged = { ...onDisk, cliBinaries: { ...binaries } };
  const tmpPath = pathImpl.join(
    pathImpl.dirname(target),
    `.${pathImpl.basename(target)}.${process.pid}.${Date.now()}.tmp`,
  );
  try {
    // Same directory as the target so the rename is a rename and not a
    // cross-device copy (which would reintroduce the partial-write window).
    fsImpl.writeFileSync(tmpPath, JSON.stringify(merged, null, 2), { mode: 0o600 });
    // `mode` is masked by umask on creation, so the chmod is what actually makes
    // it owner-only — and it runs before the rename, so the token is never even
    // briefly readable under a name something else might open.
    try { fsImpl.chmodSync(tmpPath, 0o600); } catch {}
    fsImpl.renameSync(tmpPath, target);
  } catch (error) {
    try { fsImpl.unlinkSync(tmpPath); } catch {}
    throw error;
  }
  return merged;
}

/** Tolerates leading noise (npm shim banners) by taking the last JSON object. */
function parseJsonPayload(rawOutput) {
  const text = stripTerminalEscapes(rawOutput).trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

export function createCliInstallService({
  env = process.env,
  platform = process.platform,
  spawnImpl = spawn,
  processKillImpl = process.kill.bind(process),
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
  now = () => Date.now(),
  fsImpl = fs,
  pathImpl = path,
  homedirImpl = () => os.homedir(),
  logger = console,
  // Persistence seams (§4.3 step 1). The relay stores the resolved absolute
  // paths as `cliBinaries` in its config file; tests and the route-level
  // harness hand in their own pair.
  readBoundBinaries = () => ({}),
  writeBoundBinaries = () => {},
  installTimeoutMs = CLI_INSTALL_TIMEOUT_MS,
  probeTimeoutMs = CLI_PROBE_TIMEOUT_MS,
  statusTtlMs = CLI_STATUS_TTL_MS,
  logFlushMs = CLI_INSTALL_LOG_FLUSH_MS,
} = {}) {
  const listeners = new Set();
  const successHooks = new Set();
  const install = {
    state: CLI_INSTALL_STATES.IDLE,
    providerId: null,
    action: null,
    command: '',
    log: '',
    // Monotonic across the whole relay lifetime, never reset: a client that
    // connects mid-install renders the retained buffer and can tell whether the
    // next broadcast it sees carries anything new.
    logSeq: 0,
    error: '',
    startedAt: null,
    finishedAt: null,
  };
  let session = null;
  // Bumped by every start/cancel so a slow post-close continuation can tell
  // whether it still owns the visible install state.
  let installGeneration = 0;
  // Open throttle window for log broadcasts, plus "a chunk landed inside it".
  let logFlushTimer = null;
  let logEmitPending = false;
  let boundBinaries = {};
  const probeCache = new Map();
  const probeInFlight = new Map();
  // Serialises probes per provider: a forced read never joins an older
  // in-flight probe (it could predate the install that prompted the force), but
  // it waits for it rather than running two `--version` spawns at once.
  const probeChains = new Map();

  const log = (message) => {
    try { logger?.log?.(`[cli-install] ${message}`); } catch {}
  };

  function getDescriptor(providerId) {
    const id = normalizeText(providerId).toLowerCase();
    return Object.prototype.hasOwnProperty.call(CLI_DESCRIPTORS, id) ? CLI_DESCRIPTORS[id] : null;
  }

  // ─── Binary resolution ─────────────────────────────────────────────────────

  function expandHome(dir) {
    const value = normalizeText(dir);
    if (!value) return '';
    if (value === '~') return normalizeText(homedirImpl());
    if (value.startsWith('~/') || value.startsWith('~\\')) {
      const home = normalizeText(homedirImpl());
      return home ? pathImpl.join(home, value.slice(2)) : '';
    }
    return value;
  }

  /**
   * Node has no `which`, so PATH is walked by hand. The descriptor's own bin
   * dirs come after PATH: what the shell would pick wins, and the extras only
   * cover a host where neither of the installer's symlink targets was writable
   * or on PATH.
   */
  function searchDirs(descriptor) {
    const dirs = [];
    // Ops/e2e seam: PINS resolution to these directories, PATH and the
    // descriptor's own dirs included. An isolated test relay inherits the
    // host's PATH (it has to — it runs node), so merely *preferring* a stub dir
    // would still let the host's real CLIs show up in the status rows.
    const pinned = normalizeText(env?.COPILOT_WEB_RELAY_CLI_BIN_DIR);
    if (pinned) {
      for (const dir of pinned.split(pathImpl.delimiter)) {
        if (normalizeText(dir)) dirs.push(normalizeText(dir));
      }
      return dirs;
    }
    for (const dir of String(env?.PATH || '').split(pathImpl.delimiter)) {
      if (normalizeText(dir)) dirs.push(normalizeText(dir));
    }
    for (const dir of (descriptor.extraBinDirs || [])) {
      const expanded = expandHome(dir);
      if (expanded) dirs.push(expanded);
    }
    const seen = new Set();
    return dirs.filter((dir) => {
      const key = platform === 'win32' ? dir.toLowerCase() : dir;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  /** On Windows the bare name is not executable; PATHEXT supplies the suffix. */
  function candidateNames(binary) {
    if (platform !== 'win32') return [binary];
    const extensions = String(env?.PATHEXT || '.COM;.EXE;.BAT;.CMD')
      .split(';')
      .map((ext) => normalizeText(ext).toLowerCase())
      .filter((ext) => ext.startsWith('.'));
    return [...extensions.map((ext) => `${binary}${ext}`), binary];
  }

  function isExecutableFile(candidate) {
    try {
      if (!fsImpl.statSync(candidate).isFile()) return false;
    } catch {
      return false;
    }
    try {
      fsImpl.accessSync(candidate, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * First executable match for the descriptor's binary, with the symlink
   * resolved: `realPath` is what classifies the install method (a path under
   * `…/node_modules/…` is an npm global, whatever the launcher is called).
   */
  function resolveCliBinary(providerId) {
    const descriptor = getDescriptor(providerId);
    if (!descriptor) return null;
    for (const dir of searchDirs(descriptor)) {
      for (const name of candidateNames(descriptor.binary)) {
        const candidate = pathImpl.join(dir, name);
        if (!isExecutableFile(candidate)) continue;
        let realPath = candidate;
        try { realPath = fsImpl.realpathSync(candidate); } catch {}
        return { path: candidate, realPath };
      }
    }
    return null;
  }

  function classifyInstallMethod(resolved) {
    const real = String(resolved?.realPath || resolved?.path || '').replace(/\\/g, '/');
    if (!real) return null;
    if (/\/node_modules\//i.test(real)) return 'npm-global';
    const home = normalizeText(homedirImpl()).replace(/\\/g, '/');
    if (home && real.toLowerCase().startsWith(`${home.toLowerCase()}/`)) return 'native';
    return 'system';
  }

  // ─── Spawning ──────────────────────────────────────────────────────────────

  function cliSpawnsDisabled() {
    // Same kill switch (and same truthiness rule) as
    // session-worker-launch-service.mjs and claude-auth-service.mjs: a relay
    // started with it must never run a real CLI — least of all an installer.
    if (!normalizeText(env?.COPILOT_WEB_RELAY_DISABLE_CLI_SPAWN)) return false;
    // Narrow escape hatch for the e2e harness, which keeps the kill switch on
    // (no real workers) but still drives the whole install flow. Both halves
    // are required: the opt-in flag AND an explicit command override, so
    // "spawns disabled" can never end up running a real vendor installer.
    return !(
      normalizeText(env?.COPILOT_WEB_RELAY_CLI_INSTALL_ALLOW_STUB_SPAWN)
      && normalizeText(env?.COPILOT_WEB_RELAY_CLI_INSTALL_COMMAND)
    );
  }

  /**
   * `candidateNames()` resolves `.cmd`/`.bat` through PATHEXT, and npm's shim
   * for `copilot` on a Windows host *is* `copilot.cmd` — so without the shared
   * batch-launcher handling (cli-process-runner.mjs, where the EINVAL story is
   * documented), that row would report "installed, version unknown" on every
   * probe and any `.cmd`-shimmed update/migrate would die instantly.
   */
  function isBatchLauncher(command) {
    return isBatchLauncherImpl(command, platform);
  }

  function spawnCliProcess(argv) {
    if (cliSpawnsDisabled()) throw new Error(CLI_SPAWN_DISABLED_ERROR);
    const [command, ...args] = argv;
    const batch = isBatchLauncher(command);
    const child = spawnImpl(batch ? quoteForCmd(command) : command, batch ? args.map(quoteForCmd) : args, {
      // No installer prompts, and nothing of ours to say: stdin is closed so a
      // CLI that would have asked something fails fast instead of hanging out
      // the full ten minutes.
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...env },
      ...(platform === 'win32'
        ? { windowsHide: true, ...(batch ? { shell: true } : {}) }
        // Detached so the whole group can be signalled: the vendor one-liner is
        // `bash -lc 'curl … | bash'`, and SIGTERM on the outer shell alone would
        // leave the real installer running.
        : { detached: true }),
    });
    return child;
  }

  function killTree(child, signal) {
    killProcessTree(child, signal, { platform, processKillImpl });
  }

  function terminate(child) {
    killTree(child, 'SIGTERM');
    // Deliberately not stored on the session: the session is released as soon
    // as the child closes, so a session-owned timer could be cleared before it
    // escalated and a SIGTERM-ignoring installer would live forever. Unref'd
    // and closed over the child, so it is a no-op once the child exits.
    const escalation = setTimeoutImpl(() => killTree(child, 'SIGKILL'), KILL_ESCALATION_MS);
    escalation?.unref?.();
  }

  // ─── Status probes ─────────────────────────────────────────────────────────

  function runProbeCommand(argv) {
    return runProcessToCompletion(() => spawnCliProcess(argv), {
      timeoutMs: probeTimeoutMs,
      setTimeoutImpl,
      clearTimeoutImpl,
      killChild: (child) => terminate(child),
    });
  }

  function parseVersion(descriptor, output) {
    const visible = stripTerminalEscapes(output);
    const specific = descriptor.versionPattern ? visible.match(descriptor.versionPattern) : null;
    if (specific) return specific[1];
    const generic = visible.match(GENERIC_VERSION_PATTERN);
    return generic ? generic[1] : null;
  }

  function commandsFor(descriptor, { installed }) {
    const out = {};
    for (const [action, spec] of Object.entries(descriptor.commands || {})) {
      const entry = spec.anyPlatform || (platform === 'win32' ? spec.win32 : spec.posix);
      if (!entry) continue;
      // update/migrate run the installed binary, so they only exist once there
      // is one to run.
      if (action !== 'install' && !installed) continue;
      if (action === 'install' && installed) continue;
      out[action] = { display: entry.display, targetDir: entry.targetDir };
    }
    return out;
  }

  function notInstalledStatus(descriptor, { error = null } = {}) {
    const spawnsDisabled = cliSpawnsDisabled();
    const commands = spawnsDisabled ? {} : commandsFor(descriptor, { installed: false });
    return {
      id: descriptor.id,
      label: descriptor.label,
      binary: descriptor.binary,
      installed: false,
      version: null,
      path: null,
      realPath: null,
      installMethod: null,
      updateAvailable: null,
      latestVersion: null,
      canInstall: Boolean(commands.install),
      canUpdate: false,
      blockedReason: descriptor.detectOnly
        ? descriptor.blockedReason
        : (spawnsDisabled ? CLI_SPAWN_DISABLED_ERROR : null),
      commands,
      doctor: null,
      bound: boundBinaries[descriptor.id] || null,
      error,
      checkedAt: new Date(now()).toISOString(),
    };
  }

  async function runProbe(descriptor) {
    const resolved = resolveCliBinary(descriptor.id);
    if (!resolved) return notInstalledStatus(descriptor);
    const versionRun = await runProbeCommand([resolved.path, ...(descriptor.versionArgs || [])]);
    // A binary that resolves but cannot be run at all (kill switch, exec format
    // error) is still reported as installed with its path — the row says
    // "version unknown" rather than lying about the install.
    //
    // Only a *successful* probe is scraped, though. The generic fallback pattern
    // is "any dotted number anywhere", and a failed probe's stderr is full of
    // them: `…/libc.so.6: version 'GLIBC_2.32' not found` would otherwise be
    // reported as version "2.32" with `error: null`, i.e. a broken binary
    // rendered as a healthy install. A version is a claim about a CLI that ran.
    const version = versionRun.ok ? parseVersion(descriptor, versionRun.output) : null;

    let doctor = null;
    if (descriptor.doctor) {
      const doctorRun = await runProbeCommand([resolved.path, ...descriptor.doctor.args]);
      doctor = parseClaudeDoctor(doctorRun.output);
    }
    let updateAvailable = null;
    let latestVersion = null;
    if (descriptor.checkUpdate) {
      // Exit code is deliberately ignored: `grok update --check --json` exits 0
      // either way, so only the payload counts.
      const checkRun = await runProbeCommand([resolved.path, ...descriptor.checkUpdate.args]);
      const parsed = parseJsonPayload(checkRun.output);
      if (parsed) {
        const summary = descriptor.checkUpdate.parse(parsed) || {};
        updateAvailable = summary.updateAvailable === true;
        latestVersion = summary.latestVersion || null;
      }
    }
    const spawnsDisabled = cliSpawnsDisabled();
    const commands = spawnsDisabled ? {} : commandsFor(descriptor, { installed: true });
    return {
      id: descriptor.id,
      label: descriptor.label,
      binary: descriptor.binary,
      installed: true,
      version: version || doctor?.version || null,
      path: resolved.path,
      realPath: resolved.realPath,
      // `claude doctor` names the method itself; everything else is classified
      // from the realpath the launcher points at.
      installMethod: doctor?.method || classifyInstallMethod(resolved),
      updateAvailable,
      latestVersion,
      canInstall: false,
      canUpdate: Boolean(commands.update),
      blockedReason: descriptor.detectOnly
        ? descriptor.blockedReason
        : (spawnsDisabled ? CLI_SPAWN_DISABLED_ERROR : null),
      commands,
      doctor,
      bound: boundBinaries[descriptor.id] || null,
      // A failed probe always says *something*: a silent non-zero exit would
      // otherwise render as "installed, version unknown" with nothing to go on.
      error: version ? null : (
        versionRun.error
        || tailOf(stripTerminalEscapes(versionRun.output))
        || (versionRun.ok ? null : `${descriptor.binary} ${(descriptor.versionArgs || []).join(' ')} exited with code ${versionRun.code}`)
      ),
      checkedAt: new Date(now()).toISOString(),
    };
  }

  /**
   * Resolve + probe one provider. Never throws: a failed probe resolves as a
   * status row carrying the reason, mirroring `claudeAuth.getStatus()`.
   */
  function probeCliStatus(providerId, { force = false } = {}) {
    const descriptor = getDescriptor(providerId);
    if (!descriptor) return Promise.resolve(null);
    const id = descriptor.id;
    const cached = probeCache.get(id);
    if (!force && cached && (now() - cached.at) < statusTtlMs) return Promise.resolve(cached.value);
    const running = probeInFlight.get(id);
    if (running && !force) return running;
    const pending = (probeChains.get(id) || Promise.resolve())
      .then(() => runProbe(descriptor))
      .then((value) => {
        probeCache.set(id, { at: now(), value });
        return value;
      })
      .catch((error) => {
        log(`probe failed for ${id}: ${error?.message || error}`);
        return notInstalledStatus(descriptor, { error: error?.message || String(error) });
      });
    probeChains.set(id, pending.then(() => {}, () => {}));
    probeInFlight.set(id, pending);
    const clear = () => { if (probeInFlight.get(id) === pending) probeInFlight.delete(id); };
    pending.then(clear, clear);
    return pending;
  }

  /**
   * Last probe for each provider, without ever spawning. A provider that has
   * never been probed gets the not-installed shape with a null `checkedAt`, so
   * a broadcast carries the full payload rather than dropping the field and the
   * UI can tell "not there" from "not looked at yet".
   */
  function getCachedProviders() {
    const providers = {};
    for (const descriptor of Object.values(CLI_DESCRIPTORS)) {
      providers[descriptor.id] = probeCache.get(descriptor.id)?.value
        || { ...notInstalledStatus(descriptor), checkedAt: null };
    }
    return providers;
  }

  async function getStatusSnapshot({ force = false } = {}) {
    const ids = Object.keys(CLI_DESCRIPTORS);
    const results = await Promise.all(ids.map((id) => probeCliStatus(id, { force })));
    const providers = {};
    ids.forEach((id, index) => { providers[id] = results[index]; });
    return { providers, install: installSnapshot() };
  }

  function getCachedStatusSnapshot() {
    return { providers: getCachedProviders(), install: installSnapshot() };
  }

  // ─── Binding (§4.3) ────────────────────────────────────────────────────────

  /**
   * Moves directories to the front of the relay's PATH, in the order given, so
   * anything that resolves the CLI *by name* finds the copy this service bound —
   * the Grok ACP adapter defaults to `command: 'grok'`, and a host where the
   * installer's symlink targets were unwritable would otherwise still fail after
   * a successful install. Non-existent dirs are dropped so PATH does not collect
   * dead entries.
   *
   * A directory already on PATH is *moved*, not skipped: a binding is a claim
   * that this copy wins, and a `~/.local/bin` sitting behind the npm global dir
   * would leave the launcher it replaced winning instead.
   *
   * Every child the relay spawns inherits this PATH, so callers hand it only
   * what a binding (or a just-finished install of that CLI) actually requires —
   * never every descriptor's dirs on every boot.
   */
  function hoistOntoPath(dirs) {
    const key = (dir) => (platform === 'win32' ? dir.toLowerCase() : dir);
    const wanted = [];
    const seen = new Set();
    for (const dir of (dirs || [])) {
      const expanded = expandHome(dir);
      if (!expanded || seen.has(key(expanded))) continue;
      try { if (!fsImpl.statSync(expanded).isDirectory()) continue; } catch { continue; }
      seen.add(key(expanded));
      wanted.push(expanded);
    }
    if (!wanted.length) return;
    const existing = String(env?.PATH || '').split(pathImpl.delimiter).filter(Boolean);
    const next = [...wanted, ...existing.filter((dir) => !seen.has(key(dir)))].join(pathImpl.delimiter);
    if (next !== env.PATH) env.PATH = next;
  }

  function applyEnvBinding(descriptor, binaryPath) {
    if (descriptor.envVar && binaryPath) env[descriptor.envVar] = binaryPath;
    // Only the bound binary's own directory. That is the whole of what "resolve
    // `grok` by name and get *this* copy" needs, and it keeps a boot with one
    // binding from reshuffling PATH for every child the relay ever spawns.
    if (binaryPath) hoistOntoPath([pathImpl.dirname(binaryPath)]);
  }

  /**
   * Startup half of the binding: re-apply the paths a previous install
   * persisted, so a relay that was restarted resolves exactly what it resolved
   * before.
   *
   * Nothing is touched when nothing is bound — in particular PATH is left alone.
   * This used to prepend every descriptor's bin dirs unconditionally, which
   * reordered the PATH of the relay and of every process it spawns on every
   * boot, on hosts that had never installed a CLI through it at all.
   *
   * Nothing here stops or restarts a running worker — like the Claude account
   * switch, in-flight sessions keep the binary they launched with.
   */
  function applyPersistedBindings() {
    const stored = readBoundBinaries() || {};
    const applied = {};
    for (const descriptor of Object.values(CLI_DESCRIPTORS)) {
      if (descriptor.detectOnly) continue;
      const storedPath = normalizeText(stored[descriptor.id]);
      if (!storedPath) continue;
      if (!isExecutableFile(storedPath)) {
        log(`bound ${descriptor.id} binary is gone, ignoring: ${storedPath}`);
        continue;
      }
      applyEnvBinding(descriptor, storedPath);
      applied[descriptor.id] = storedPath;
    }
    boundBinaries = applied;
    return { ...applied };
  }

  function bindResolvedBinary(descriptor, binaryPath) {
    applyEnvBinding(descriptor, binaryPath);
    boundBinaries = { ...boundBinaries, [descriptor.id]: binaryPath };
    try {
      writeBoundBinaries({ ...boundBinaries });
    } catch (error) {
      // A config write that fails costs the binding across a restart, not this
      // one: the env vars are already applied in-process.
      log(`failed to persist the resolved ${descriptor.id} binary: ${error?.message || error}`);
    }
  }

  function getBoundBinaries() {
    return { ...boundBinaries };
  }

  // ─── Install / update ──────────────────────────────────────────────────────

  function installSnapshot() {
    return {
      state: install.state,
      providerId: install.providerId,
      action: install.action,
      command: install.command || null,
      log: install.log,
      logSeq: install.logSeq,
      error: install.error || null,
      startedAt: install.startedAt || null,
      finishedAt: install.finishedAt || null,
      active: Boolean(session),
    };
  }

  function emitState() {
    const snapshot = installSnapshot();
    for (const listener of [...listeners]) {
      try { listener(snapshot); } catch (error) { log(`listener failed: ${error?.message || error}`); }
    }
  }

  /**
   * Log broadcasts are coalesced; state transitions are not.
   *
   * Every emit carries the *whole* retained 16 KB buffer to every connected
   * socket, and a progress-bar installer produces a chunk per frame — one emit
   * each would flood every client for up to the full ten-minute timeout. So the
   * first chunk goes out at once (the log appears immediately), further chunks
   * inside the window collapse into a single trailing emit, and a window with
   * nothing pending simply lapses so the next chunk is immediate again.
   *
   * The payload shape is untouched: `log` is still the entire retained buffer
   * and `logSeq` still counts every chunk — a client just sees it advance by
   * more than one between broadcasts, which is exactly what the sequence number
   * exists to let it notice.
   */
  function clearLogFlush() {
    if (logFlushTimer) clearTimeoutImpl(logFlushTimer);
    logFlushTimer = null;
    logEmitPending = false;
  }

  function armLogFlush() {
    logFlushTimer = setTimeoutImpl(() => {
      logFlushTimer = null;
      if (!logEmitPending) return;
      logEmitPending = false;
      emitState();
      // Re-armed only while output is still arriving, so a quiet installer is
      // not left holding a timer.
      armLogFlush();
    }, logFlushMs);
    logFlushTimer?.unref?.();
  }

  function emitLogState() {
    if (logFlushTimer) {
      logEmitPending = true;
      return;
    }
    emitState();
    armLogFlush();
  }

  function setInstallState(nextState, { error } = {}) {
    install.state = nextState;
    if (error !== undefined) install.error = error || '';
    // A transition is never coalesced, and it cancels any pending flush: the
    // snapshot it is about to emit already carries the complete log, so the
    // terminal state always ships the whole thing.
    clearLogFlush();
    emitState();
  }

  function appendInstallLog(current, text) {
    if (session !== current) return;
    // Escape-stripped before it is retained, so no ANSI/OSC payload ever
    // reaches a browser (it still goes through escHtml on the way to the DOM).
    install.log = `${install.log}${stripTerminalEscapes(text)}`.slice(-MAX_CAPTURED_OUTPUT_CHARS);
    install.logSeq += 1;
    emitLogState();
  }

  /**
   * Resolves the frozen argv for `action`, with `<bin>` replaced by the
   * resolved absolute binary. Returns null when this platform (or this
   * provider) has no such command — never a partially-built one.
   */
  function resolveActionCommand(descriptor, action, resolvedPath) {
    const spec = descriptor.commands?.[action];
    if (!spec) return null;
    const entry = spec.anyPlatform || (platform === 'win32' ? spec.win32 : spec.posix);
    if (!entry) return null;
    const override = normalizeText(env?.COPILOT_WEB_RELAY_CLI_INSTALL_COMMAND);
    if (override) {
      // Stub path for the e2e harness: the descriptor id and action are the
      // frozen values resolved above, never the raw request body.
      return { argv: [override, descriptor.id, action], display: entry.display, targetDir: entry.targetDir };
    }
    if (!entry.argv.includes(BIN_PLACEHOLDER)) {
      return { argv: [...entry.argv], display: entry.display, targetDir: entry.targetDir };
    }
    if (!resolvedPath) return null;
    return {
      argv: entry.argv.map((part) => (part === BIN_PLACEHOLDER ? resolvedPath : part)),
      display: entry.display,
      targetDir: entry.targetDir,
    };
  }

  function runInstall(providerId, { action = 'install' } = {}) {
    const descriptor = getDescriptor(providerId);
    // The id never reaches a command, and it is not echoed back either: an
    // unknown one is simply not a provider.
    if (!descriptor) {
      return { ok: false, statusCode: 400, error: 'Unknown CLI provider', install: installSnapshot() };
    }
    if (descriptor.detectOnly) {
      return {
        ok: false,
        statusCode: 400,
        error: descriptor.blockedReason || `${descriptor.label} cannot be installed from the relay`,
        install: installSnapshot(),
      };
    }
    const normalizedAction = normalizeText(action).toLowerCase() || 'install';
    if (!Object.prototype.hasOwnProperty.call(descriptor.commands || {}, normalizedAction)) {
      return { ok: false, statusCode: 400, error: 'Unknown install action', install: installSnapshot() };
    }
    if (session) {
      // A double-clicked button joins the run already in flight; anything else
      // is refused, because two installers writing ~/.local/bin at once is the
      // failure this single-flight exists to prevent.
      if (session.descriptor.id === descriptor.id && session.action === normalizedAction) {
        return { ok: true, reused: true, install: installSnapshot() };
      }
      return {
        ok: false,
        statusCode: 409,
        error: `Another CLI install is already running (${session.descriptor.label})`,
        install: installSnapshot(),
      };
    }
    if (cliSpawnsDisabled()) {
      installGeneration += 1;
      install.providerId = descriptor.id;
      install.action = normalizedAction;
      install.command = '';
      setInstallState(CLI_INSTALL_STATES.ERROR, { error: CLI_SPAWN_DISABLED_ERROR });
      return { ok: false, statusCode: 503, error: CLI_SPAWN_DISABLED_ERROR, install: installSnapshot() };
    }
    const resolvedPath = resolveCliBinary(descriptor.id)?.path || '';
    const command = resolveActionCommand(descriptor, normalizedAction, resolvedPath);
    if (!command) {
      return {
        ok: false,
        statusCode: 409,
        error: resolvedPath
          ? `${descriptor.label} has no ${normalizedAction} command on this platform`
          : `${descriptor.label} is not installed, so it cannot be ${normalizedAction}d`,
        install: installSnapshot(),
      };
    }

    installGeneration += 1;
    // Stamped on the session so a late close from a cancelled (or superseded)
    // run cannot publish an outcome over a newer one.
    const current = { descriptor, action: normalizedAction, child: null, generation: installGeneration };
    session = current;
    install.providerId = descriptor.id;
    install.action = normalizedAction;
    install.command = command.display;
    install.log = '';
    install.error = '';
    install.startedAt = new Date(now()).toISOString();
    install.finishedAt = null;
    setInstallState(CLI_INSTALL_STATES.RUNNING, { error: '' });

    void runProcessToCompletion(() => spawnCliProcess(command.argv), {
      timeoutMs: installTimeoutMs,
      setTimeoutImpl,
      clearTimeoutImpl,
      killChild: (child) => terminate(child),
      maxOutputChars: MAX_CAPTURED_OUTPUT_CHARS,
      onChild: (child) => { current.child = child; },
      onOutput: (text) => appendInstallLog(current, text),
    }).then((result) => finishInstall(current, result));

    return { ok: true, reused: false, install: installSnapshot() };
  }

  async function finishInstall(current, result) {
    if (session === current) session = null;
    // A cancel (or a newer install, or dispose) already owns the visible state.
    if (current.generation !== installGeneration) return;
    install.finishedAt = new Date(now()).toISOString();
    if (!result.ok) {
      const tail = tailOf(stripTerminalEscapes(result.output));
      setInstallState(CLI_INSTALL_STATES.ERROR, {
        error: result.error
          || tail
          || `${current.descriptor.label} ${current.action} exited with code ${result.code}`,
      });
      return;
    }
    // Before the post-install resolve, never after it. `claude migrate` installs
    // the native build into the descriptor's own bin dir while the npm-global
    // launcher it exists to replace is still ahead of that dir on PATH, so a
    // resolve against the untouched PATH would bind — and persist — the very
    // launcher the migration was run to get away from, and report SUCCESS doing
    // it. Hoisting first also keeps the bound path and name-resolution in
    // agreement: whatever `grok` means to a spawned child is what got bound.
    hoistOntoPath(current.descriptor.extraBinDirs);
    // Success is decided by exit code AND a post-install resolve, never by
    // parsing installer output: an installer that changes its banner must not
    // be able to turn a working install into a failure, or the reverse.
    const status = await probeCliStatus(current.descriptor.id, { force: true });
    if (current.generation !== installGeneration) {
      log('skipping post-install binding: a newer install took over');
      return;
    }
    if (!status?.installed || !status.path) {
      setInstallState(CLI_INSTALL_STATES.ERROR, {
        error: `${current.descriptor.label} ${current.action} finished but ${current.descriptor.binary} was not found on PATH`,
      });
      return;
    }
    bindResolvedBinary(current.descriptor, status.path);
    // Re-read so the broadcast carries the freshly bound path.
    probeCache.set(current.descriptor.id, {
      at: now(),
      value: { ...status, bound: boundBinaries[current.descriptor.id] || null },
    });
    setInstallState(CLI_INSTALL_STATES.SUCCESS, { error: '' });
    for (const hook of [...successHooks]) {
      try {
        await hook({ providerId: current.descriptor.id, action: current.action, status });
      } catch (error) {
        log(`post-install hook failed: ${error?.message || error}`);
      }
    }
  }

  /**
   * Kills the running install, and doubles as the "dismiss the terminal state"
   * path for the UI. An install killed mid-download leaves a partial file in
   * the vendor's own download dir; both installers re-download, so pressing
   * Install again recovers.
   */
  function cancel() {
    const current = session;
    installGeneration += 1;
    if (current) {
      if (current.child) terminate(current.child);
      session = null;
      install.finishedAt = new Date(now()).toISOString();
      setInstallState(CLI_INSTALL_STATES.CANCELLED, {
        error: `${current.descriptor.label} ${current.action} cancelled`,
      });
      return { ok: true, install: installSnapshot() };
    }
    install.providerId = null;
    install.action = null;
    install.command = '';
    install.startedAt = null;
    install.finishedAt = null;
    setInstallState(CLI_INSTALL_STATES.IDLE, { error: '' });
    return { ok: true, install: installSnapshot() };
  }

  function subscribe(listener) {
    if (typeof listener !== 'function') return () => {};
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function onInstallSuccess(hook) {
    if (typeof hook !== 'function') return () => {};
    successHooks.add(hook);
    return () => successHooks.delete(hook);
  }

  function dispose() {
    const current = session;
    if (current) {
      installGeneration += 1;
      if (current.child) terminate(current.child);
      session = null;
    }
    clearLogFlush();
    listeners.clear();
    successHooks.clear();
  }

  return {
    getDescriptor,
    resolveCliBinary,
    probeCliStatus,
    getStatusSnapshot,
    getCachedStatusSnapshot,
    getInstallState: installSnapshot,
    applyPersistedBindings,
    getBoundBinaries,
    runInstall,
    cancel,
    subscribe,
    onInstallSuccess,
    dispose,
  };
}
