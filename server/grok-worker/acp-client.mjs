/**
 * Minimal ACP JSON-RPC client over a child-process stdio transport.
 * Adapted from grok-remote research (read-only reference); lives in
 * copilot-remote so the Grok provider does not depend on that tree.
 */
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import readline from 'node:readline';

function whichCommand(command = 'grok') {
  const value = String(command || 'grok').trim() || 'grok';
  return value;
}

// Prompt watchdog defaults: a turn that produces no ACP traffic for the
// inactivity window (while no client-side work is pending) is stalled; the
// ceiling bounds a single prompt absolutely. Both are overridable per call.
export const ACP_PROMPT_INACTIVITY_MS = 120_000;
export const ACP_PROMPT_MAX_TURN_MS = 1_800_000;

/**
 * Pick the one-shot allow option from an ACP permission request. A blanket
 * "allow always" would grant more than the relay's per-request approval
 * parity intends; a missing/unrecognizable option list falls back to the
 * conventional id.
 */
export function pickAllowOnceOptionId(rawOptions) {
  const options = Array.isArray(rawOptions) ? rawOptions : [];
  const idOf = (opt) => String(opt?.optionId || opt?.id || '').toLowerCase();
  const allowOnce = options.find((opt) => {
    const id = idOf(opt);
    return id.includes('allow') && !id.includes('always') && !id.includes('reject') && !id.includes('deny');
  });
  const allowAny = options.find((opt) => idOf(opt).includes('allow'));
  return String(
    allowOnce?.optionId || allowOnce?.id
    || allowAny?.optionId || allowAny?.id
    || 'allow-once',
  );
}

export class AcpClient extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} [opts.command]
   * @param {string[]} [opts.args]
   * @param {string} [opts.cwd]
   * @param {NodeJS.ProcessEnv} [opts.env]
   * @param {boolean} [opts.alwaysApprove]
   * @param {typeof spawn} [opts.spawnImpl]
   */
  constructor(opts = {}) {
    super();
    this.command = whichCommand(opts.command || 'grok');
    this.args = Array.isArray(opts.args) ? [...opts.args] : ['agent', '--no-leader', 'stdio'];
    if (opts.alwaysApprove && !this.args.includes('--always-approve') && !this.args.includes('--yolo')) {
      const i = this.args.indexOf('agent');
      if (i >= 0) this.args = [...this.args.slice(0, i + 1), '--always-approve', ...this.args.slice(i + 1)];
      else this.args = ['--always-approve', ...this.args];
    }
    this.spawnCwd = opts.cwd || process.cwd();
    this.env = opts.env || process.env;
    this.spawnImpl = opts.spawnImpl || spawn;
    this.proc = null;
    this.rl = null;
    this.nextId = 1;
    this.pending = new Map();
    this.requestHandlers = new Map();
    this._bufferErr = '';
    this.dead = false;
    this.initializeResult = null;
    this.lastActivityAt = Date.now();
  }

  _touchActivity() {
    this.lastActivityAt = Date.now();
  }

  /**
   * Register a handler for an agent→client request method (terminal/*, fs/*).
   * The handler receives the request params and its resolved value is sent as
   * the JSON-RPC result (undefined becomes null); a rejection is sent as a
   * -32603 error so the agent's tool call fails instead of hanging.
   */
  setRequestHandler(method, handler) {
    this.requestHandlers.set(String(method || ''), handler);
  }

  start() {
    if (this.proc) return;

    this.proc = this.spawnImpl(this.command, this.args, {
      cwd: this.spawnCwd,
      env: {
        ...this.env,
        GROK_DISABLE_AUTOUPDATER: this.env.GROK_DISABLE_AUTOUPDATER || '1',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      shell: false,
    });

    this.rl = readline.createInterface({ input: this.proc.stdout, crlfDelay: Infinity });
    this.rl.on('line', (line) => this._onLine(line));

    this.proc.stderr.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      this._bufferErr += text;
      this.emit('stderr', text);
    });

    this.proc.on('error', (err) => {
      this.dead = true;
      // Reject pending requests first: an EventEmitter 'error' emit with no
      // listener throws ERR_UNHANDLED_ERROR synchronously, which would
      // otherwise escape the spawn callback and crash the host process
      // (e.g. the relay server during model discovery with no CLI on PATH).
      this._rejectAll(err);
      if (this.listenerCount('error') > 0) this.emit('error', err);
    });

    this.proc.on('exit', (code, signal) => {
      this.dead = true;
      this.emit('exit', { code, signal });
      this._rejectAll(new Error(`agent exited code=${code} signal=${signal}`));
    });
  }

  _onLine(line) {
    const trimmed = line.trim();
    if (!trimmed) return;
    this._touchActivity();
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      this.emit('parseError', trimmed);
      return;
    }

    if (msg.id != null && (msg.result !== undefined || msg.error !== undefined)) {
      const p = this.pending.get(msg.id);
      if (p) {
        this.pending.delete(msg.id);
        if (msg.error) {
          p.reject(Object.assign(new Error(msg.error.message || 'ACP error'), { acp: msg.error }));
        } else {
          p.resolve(msg.result);
        }
      }
      return;
    }

    if (msg.method) {
      this.emit('notification', msg);
      // Method-named convenience events — except 'error', which EventEmitter
      // treats specially: an agent sending {"method":"error"} would otherwise
      // throw ERR_UNHANDLED_ERROR and kill the worker.
      if (msg.method !== 'error') this.emit(msg.method, msg);
      if (msg.id == null) return;
      if (msg.method === 'session/request_permission') {
        // The turn runner attaches its listener only while a prompt is in
        // flight. A permission request arriving outside that window (a
        // session/load replay, a request racing prompt settlement) must still
        // get a reply — an unanswered agent→client request deadlocks the
        // agent, the exact failure the -32601 fallback below exists for.
        if (this.listenerCount('permission') === 0) {
          const optionId = pickAllowOnceOptionId(msg?.params?.options);
          this.respond(msg.id, { outcome: { outcome: 'selected', optionId } });
          return;
        }
        this.emit('permission', msg);
        return;
      }
      const handler = this.requestHandlers.get(msg.method);
      if (!handler) {
        // Fail fast: an agent→client request that never gets a response
        // deadlocks the agent's turn — it waits forever on the reply (the
        // 0117fb12 stall: terminal/create was advertised but unanswered).
        // Method-not-found turns a capability mismatch into a visible tool
        // error instead of a silent hang.
        this.respondError(msg.id, `Method not found: ${msg.method}`, -32601);
        return;
      }
      Promise.resolve()
        .then(() => handler(msg.params || {}))
        .then(
          (result) => this.respond(msg.id, result === undefined ? null : result),
          (error) => this.respondError(msg.id, error?.message || 'request handler failed', -32603),
        );
    }
  }

  _rejectAll(err) {
    for (const [, p] of this.pending) p.reject(err);
    this.pending.clear();
  }

  request(method, params = {}, timeoutMs = 120000) {
    if (this.dead) return Promise.reject(new Error('agent is dead'));
    this.start();
    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    return new Promise((resolve, reject) => {
      // timeoutMs <= 0 = no request-level timeout (an unlimited-ceiling
      // prompt); the caller's watchdog owns liveness in that case.
      const timer = Number(timeoutMs) > 0
        ? setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`ACP request timeout: ${method}`));
        }, timeoutMs)
        : null;
      // A pending request must not keep the process alive on its own — an
      // abandoned prompt (watchdog raced past it) would otherwise pin the
      // event loop for the full timeout.
      if (timer && typeof timer.unref === 'function') timer.unref();
      this.pending.set(id, {
        resolve: (v) => {
          if (timer) clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          if (timer) clearTimeout(timer);
          reject(e);
        },
      });
      this._touchActivity();
      this.proc.stdin.write(`${payload}\n`, 'utf8');
    });
  }

  notify(method, params = {}) {
    if (this.dead) return;
    this.start();
    const payload = JSON.stringify({ jsonrpc: '2.0', method, params });
    this._touchActivity();
    this.proc.stdin.write(`${payload}\n`, 'utf8');
  }

  respond(id, result) {
    if (this.dead) return;
    const payload = JSON.stringify({ jsonrpc: '2.0', id, result });
    this._touchActivity();
    this.proc.stdin.write(`${payload}\n`, 'utf8');
  }

  respondError(id, message, code = -32000) {
    if (this.dead) return;
    const payload = JSON.stringify({
      jsonrpc: '2.0',
      id,
      error: { code, message },
    });
    this._touchActivity();
    this.proc.stdin.write(`${payload}\n`, 'utf8');
  }

  async initialize(clientInfo = { name: 'copilot-remote-grok', version: '1.0.0' }) {
    this.start();
    this.initializeResult = await this.request('initialize', {
      protocolVersion: 1,
      // Each capability advertised here is a contract to answer the agent's
      // matching requests — the handlers live in acp-host-services.mjs and
      // must be attached via setRequestHandler before the first prompt. An
      // advertised-but-unanswered request deadlocks the agent's turn (the
      // 0117fb12 stall: terminal/create waited forever on a reply).
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: true,
      },
      clientInfo,
    });
    // Do not send the generic ACP `initialized` notification: current Grok CLI
    // agent builds log `failed to decode … Method not found` for it and ignore
    // it. Session/new works without it.
    return this.initializeResult;
  }

  async sessionNew(cwd, extra = {}) {
    return this.request('session/new', {
      cwd,
      mcpServers: [],
      ...extra,
    });
  }

  async sessionLoad(sessionId, cwd, extra = {}) {
    return this.request('session/load', {
      sessionId,
      cwd,
      mcpServers: [],
      ...extra,
    });
  }

  /**
   * Send a prompt and stream session/update until the prompt request resolves.
   *
   * A watchdog replaces the old flat request timeout: the prompt fails when no
   * ACP traffic (in either direction) happens for `inactivityMs` while no
   * client-side work is pending (`hasPendingWork`), or when `maxTurnMs` is
   * exceeded outright. On a trip the session is cancelled best-effort and the
   * promise rejects with a message classifyGrokError maps to grok.turn-stalled.
   *
   * @param {string} sessionId
   * @param {Array} prompt content blocks
   * @param {(update: object) => void} [onUpdate]
   * @param {object} [extra] additional session/prompt params (e.g. `_meta`)
   * @param {object} [watchdog] { inactivityMs, maxTurnMs, hasPendingWork }
   */
  async sessionPrompt(sessionId, prompt, onUpdate, extra = {}, watchdog = {}) {
    const inactivityMs = Number(watchdog?.inactivityMs) > 0
      ? Number(watchdog.inactivityMs)
      : ACP_PROMPT_INACTIVITY_MS;
    // An explicit 0 means NO absolute ceiling (the user's "No limit"
    // setting); only an absent/invalid value falls back to the default. The
    // inactivity watchdog still catches dead transports either way.
    const rawMaxTurnMs = Number(watchdog?.maxTurnMs);
    const maxTurnMs = Number.isFinite(rawMaxTurnMs) && rawMaxTurnMs >= 0
      ? rawMaxTurnMs
      : ACP_PROMPT_MAX_TURN_MS;
    const hasPendingWork = typeof watchdog?.hasPendingWork === 'function'
      ? watchdog.hasPendingWork
      : () => false;
    const handler = (msg) => {
      if (msg.method !== 'session/update') return;
      if (msg.params?.sessionId && msg.params.sessionId !== sessionId) return;
      onUpdate?.(msg.params?.update || msg.params);
    };
    this.on('notification', handler);
    let watchdogTimer = null;
    const startedAt = Date.now();
    const stallPromise = new Promise((_, reject) => {
      const pollMs = Math.max(250, Math.min(5000, Math.floor(inactivityMs / 4)));
      watchdogTimer = setInterval(() => {
        const now = Date.now();
        if (maxTurnMs > 0 && now - startedAt >= maxTurnMs) {
          try { this.sessionCancel(sessionId); } catch { /* ignore */ }
          reject(new Error(`grok turn exceeded the ${Math.round(maxTurnMs / 60000)}-minute turn ceiling`));
          return;
        }
        if (hasPendingWork()) return;
        if (now - this.lastActivityAt >= inactivityMs) {
          try { this.sessionCancel(sessionId); } catch { /* ignore */ }
          reject(new Error(`grok turn stalled: no ACP activity for ${Math.round(inactivityMs / 1000)}s`));
        }
      }, pollMs);
      if (typeof watchdogTimer.unref === 'function') watchdogTimer.unref();
    });
    try {
      // The race keeps both promises observed, so the late loser cannot
      // become an unhandled rejection. The raw request timeout sits above
      // the ceiling; the watchdog is the real limiter.
      return await Promise.race([
        this.request(
          'session/prompt',
          { sessionId, prompt, ...extra },
          maxTurnMs > 0 ? maxTurnMs + 60_000 : 0,
        ),
        stallPromise,
      ]);
    } finally {
      clearInterval(watchdogTimer);
      this.off('notification', handler);
    }
  }

  sessionCancel(sessionId) {
    this.notify('session/cancel', { sessionId });
  }

  async dispose() {
    this.dead = true;
    try {
      this.rl?.close();
    } catch {
      /* ignore */
    }
    if (this.proc && !this.proc.killed) {
      this.proc.kill();
      if (process.platform === 'win32' && this.proc.pid) {
        try {
          this.spawnImpl('taskkill', ['/pid', String(this.proc.pid), '/t', '/f'], {
            stdio: 'ignore',
            windowsHide: true,
          });
        } catch {
          /* ignore */
        }
      }
    }
    this.proc = null;
  }
}

/**
 * Extract model ids + reasoning efforts from an ACP initialize result.
 * Pure helper for unit tests and model discovery.
 */
export function extractGrokModelsFromInitialize(initResult = null) {
  const meta = initResult?._meta || initResult?.agentCapabilities?._meta || {};
  const modelState = meta.modelState || {};
  const available = Array.isArray(modelState.availableModels) ? modelState.availableModels : [];
  const models = [];
  const effortsByModel = {};
  const contextWindowsByModel = {};
  for (const entry of available) {
    const modelId = String(
      typeof entry === 'string' ? entry : (entry?.modelId || entry?.id || entry?.name || ''),
    ).trim();
    if (!modelId) continue;
    models.push(modelId);
    const efforts = Array.isArray(entry?.reasoningEfforts)
      ? entry.reasoningEfforts.map((v) => String(v || '').trim().toLowerCase()).filter(Boolean)
      : [];
    if (efforts.length) effortsByModel[modelId.toLowerCase()] = efforts;
    const contextWindow = Number(
      entry?.contextWindow ?? entry?.context_window ?? entry?.maxContextTokens ?? entry?.maxTokens,
    );
    if (Number.isFinite(contextWindow) && contextWindow > 0) {
      contextWindowsByModel[modelId.toLowerCase()] = Math.round(contextWindow);
    }
  }
  const currentModelId = String(modelState.currentModelId || '').trim();
  if (currentModelId && !models.some((m) => m.toLowerCase() === currentModelId.toLowerCase())) {
    models.unshift(currentModelId);
  }
  return {
    models,
    defaultModel: currentModelId || models[0] || '',
    effortsByModel,
    contextWindowsByModel,
  };
}
