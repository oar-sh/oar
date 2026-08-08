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
    this._bufferErr = '';
    this.dead = false;
    this.initializeResult = null;
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
      this.emit(msg.method, msg);
      if (msg.method === 'session/request_permission' && msg.id != null) {
        this.emit('permission', msg);
      }
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
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`ACP request timeout: ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.proc.stdin.write(`${payload}\n`, 'utf8');
    });
  }

  notify(method, params = {}) {
    if (this.dead) return;
    this.start();
    const payload = JSON.stringify({ jsonrpc: '2.0', method, params });
    this.proc.stdin.write(`${payload}\n`, 'utf8');
  }

  respond(id, result) {
    if (this.dead) return;
    const payload = JSON.stringify({ jsonrpc: '2.0', id, result });
    this.proc.stdin.write(`${payload}\n`, 'utf8');
  }

  respondError(id, message) {
    if (this.dead) return;
    const payload = JSON.stringify({
      jsonrpc: '2.0',
      id,
      error: { code: -32000, message },
    });
    this.proc.stdin.write(`${payload}\n`, 'utf8');
  }

  async initialize(clientInfo = { name: 'copilot-remote-grok', version: '1.0.0' }) {
    this.start();
    this.initializeResult = await this.request('initialize', {
      protocolVersion: 1,
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
   * @param {string} sessionId
   * @param {Array} prompt content blocks
   * @param {(update: object) => void} [onUpdate]
   * @param {object} [extra] additional session/prompt params (e.g. `_meta`)
   */
  async sessionPrompt(sessionId, prompt, onUpdate, extra = {}) {
    const handler = (msg) => {
      if (msg.method !== 'session/update') return;
      if (msg.params?.sessionId && msg.params.sessionId !== sessionId) return;
      onUpdate?.(msg.params?.update || msg.params);
    };
    this.on('notification', handler);
    try {
      return await this.request(
        'session/prompt',
        { sessionId, prompt, ...extra },
        600000,
      );
    } finally {
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
