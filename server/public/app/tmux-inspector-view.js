import { currentConvId, conversations, showTransientRelayNotice } from './store.js';
import { getSocket } from './socket-handlers.js';

let inspectorState = {
  open: false,
  sdkSessionId: '',
  terminal: null,
  fitAddon: null,
  plainOutput: null,
  usesPlainOutput: false,
  lastResizeCols: null,
  lastResizeRows: null,
  socket: null,
  listenersBound: false,
};

// The files index.html loads, and unpkg as the fallback: one package version
// and one hash per file, so either CDN must serve the same bytes.
const XTERM_STYLE_INTEGRITY = 'sha384-8Xk9wy/gzEDUKrXtrmCFa2bBuK3BpjpDuL/p0SeKQX19Khl/M+lHOgD/CyYf7efP';
const XTERM_SCRIPT_INTEGRITY = 'sha384-M169f14mRZOXm3hD/v2Ti0ThIT/RnAQagXA9nlE15yHAtrW19gdePJh/HaTzUOe/';
const XTERM_FIT_SCRIPT_INTEGRITY = 'sha384-iF+jqbuti4XlB64clWgFWYEscb+UnSRv3VgVikGYZu+otNFnSHr7y7NcKfBnGizn';
export const XTERM_STYLE_CANDIDATES = [
  { url: 'https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/css/xterm.css', integrity: XTERM_STYLE_INTEGRITY },
  { url: 'https://unpkg.com/@xterm/xterm@5.5.0/css/xterm.css', integrity: XTERM_STYLE_INTEGRITY },
];
export const XTERM_SCRIPT_CANDIDATES = [
  { url: 'https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/lib/xterm.js', integrity: XTERM_SCRIPT_INTEGRITY },
  { url: 'https://unpkg.com/@xterm/xterm@5.5.0/lib/xterm.js', integrity: XTERM_SCRIPT_INTEGRITY },
];
export const XTERM_FIT_SCRIPT_CANDIDATES = [
  { url: 'https://cdn.jsdelivr.net/npm/@xterm/addon-fit@0.10.0/lib/addon-fit.js', integrity: XTERM_FIT_SCRIPT_INTEGRITY },
  { url: 'https://unpkg.com/@xterm/addon-fit@0.10.0/lib/addon-fit.js', integrity: XTERM_FIT_SCRIPT_INTEGRITY },
];

let xtermLoadPromise = null;
let resizeDebounceTimer = null;

function resolveCurrentSessionId() {
  const convId = String(currentConvId || '').trim();
  if (!convId) return '';
  const conversation = conversations?.[convId] || null;
  return String(conversation?.sdkSessionId || conversation?.sdk_session_id || '').trim();
}

function setStatus(text = '', isError = false) {
  const statusEl = document.getElementById('tmux-inspector-status');
  if (!statusEl) return;
  statusEl.textContent = String(text || '').trim();
  statusEl.dataset.state = isError ? 'error' : 'ok';
}

function resolveTerminalRuntime() {
  const TerminalCtor = window?.Terminal;
  return typeof TerminalCtor === 'function' ? TerminalCtor : null;
}

function stripAnsiControlCodes(input = '') {
  return String(input || '')
    // OSC ... BEL or ST
    .replace(/\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g, '')
    // CSI sequence
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, '')
    // 2-byte escape
    .replace(/\u001B[@-_]/g, '')
    // C1 control CSI (single-byte 0x9B)
    .replace(/\u009B[0-?]*[ -/]*[@-~]/g, '')
    // other non-printing controls except LF/TAB
    .replace(/[\u0000-\u0008\u000B-\u001A\u001C-\u001F\u007F]/g, '')
    .replace(/\r(?!\n)/g, '');
}

function loadScript(src, integrity = '') {
  return new Promise((resolve, reject) => {
    const timeoutMs = 3500;
    let settled = false;
    const finishResolve = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const finishReject = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    };
    const timer = setTimeout(() => {
      finishReject(new Error(`Timed out loading ${src}`));
    }, timeoutMs);

    const existing = Array.from(document.querySelectorAll('script[src]'))
      .find((node) => String(node.getAttribute('src') || '').trim() === src);
    if (existing) {
      if (existing.dataset.loaded === 'true') {
        finishResolve();
        return;
      }
      if (existing.dataset.failed === 'true') {
        finishReject(new Error(`Failed to load ${src}`));
        return;
      }
      existing.addEventListener('load', () => finishResolve(), { once: true });
      existing.addEventListener('error', () => finishReject(new Error(`Failed to load ${src}`)), { once: true });
      return;
    }
    const script = document.createElement('script');
    script.src = src;
    if (integrity) {
      script.integrity = integrity;
      script.crossOrigin = 'anonymous';
    }
    script.async = true;
    script.onload = () => {
      script.dataset.loaded = 'true';
      finishResolve();
    };
    script.onerror = () => {
      script.dataset.failed = 'true';
      finishReject(new Error(`Failed to load ${src}`));
    };
    document.head.appendChild(script);
  });
}

function ensureStylesheet(candidates = []) {
  for (const { url, integrity } of candidates) {
    const hrefText = String(url || '').trim();
    if (!hrefText) continue;
    const already = Array.from(document.querySelectorAll('link[rel="stylesheet"]'))
      .some((node) => String(node.getAttribute('href') || '').trim() === hrefText);
    if (already) return;
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = hrefText;
    if (integrity) {
      link.integrity = integrity;
      link.crossOrigin = 'anonymous';
    }
    document.head.appendChild(link);
    return;
  }
}

async function loadFirstSuccessful(candidates = []) {
  let lastError = null;
  for (const { url, integrity } of candidates) {
    const src = String(url || '').trim();
    if (!src) continue;
    try {
      await loadScript(src, integrity);
      return true;
    } catch (error) {
      lastError = error;
    }
  }
  if (lastError) throw lastError;
  return false;
}

async function ensureTerminalRuntimeLoaded() {
  const existing = resolveTerminalRuntime();
  if (existing) return existing;
  if (!xtermLoadPromise) {
    xtermLoadPromise = (async () => {
      ensureStylesheet(XTERM_STYLE_CANDIDATES);
      await loadFirstSuccessful(XTERM_SCRIPT_CANDIDATES);
      await loadFirstSuccessful(XTERM_FIT_SCRIPT_CANDIDATES);
      return resolveTerminalRuntime();
    })().catch(() => {
      xtermLoadPromise = null;
      return null;
    });
  }
  return xtermLoadPromise;
}

function fitTerminal() {
  if (inspectorState.usesPlainOutput) return;
  try {
    inspectorState.fitAddon?.fit?.();
  } catch {}
  scheduleTmuxResizeSync();
}

function ensureSocketListeners(socket) {
  if (!socket || inspectorState.listenersBound) return;
  inspectorState.listenersBound = true;
  socket.on('tmux_inspector_chunk', (event = {}) => {
    if (!inspectorState.open) return;
    const sessionId = String(event?.sdkSessionId || '').trim();
    if (!sessionId || sessionId !== inspectorState.sdkSessionId) return;
    const data = String(event?.data || '');
    if (!data) return;
    if (inspectorState.usesPlainOutput) {
      if (inspectorState.plainOutput) {
        inspectorState.plainOutput.textContent += stripAnsiControlCodes(data);
        inspectorState.plainOutput.scrollTop = inspectorState.plainOutput.scrollHeight;
      }
      return;
    }
    inspectorState.terminal?.write(data);
  });
  socket.on('tmux_inspector_status', (event = {}) => {
    if (!inspectorState.open) return;
    const sessionId = String(event?.sdkSessionId || '').trim();
    if (!sessionId || sessionId !== inspectorState.sdkSessionId) return;
    const state = String(event?.state || '').trim().toLowerCase();
    const reason = String(event?.reason || '').trim();
    if (state === 'ended') {
      setStatus(reason || 'Session stream ended', true);
      return;
    }
    if (state === 'error') {
      setStatus(reason || 'Session stream error', true);
      return;
    }
    setStatus(reason || 'Streaming', false);
  });
}

function hideModal() {
  const modal = document.getElementById('tmux-inspector-modal');
  if (!modal) return;
  modal.classList.remove('visible');
  modal.setAttribute('aria-hidden', 'true');
}

function showModal() {
  const modal = document.getElementById('tmux-inspector-modal');
  if (!modal) return;
  modal.classList.add('visible');
  modal.setAttribute('aria-hidden', 'false');
}

function closeTmuxInspector({ notifyServer = true } = {}) {
  const socket = inspectorState.socket;
  const sessionId = inspectorState.sdkSessionId;
  if (notifyServer && socket && sessionId) {
    try {
      socket.emit('tmux_inspector_close', { sdkSessionId: sessionId });
    } catch {}
  }
  try {
    inspectorState.terminal?.dispose?.();
  } catch {}
  if (resizeDebounceTimer) {
    clearTimeout(resizeDebounceTimer);
    resizeDebounceTimer = null;
  }
  inspectorState = {
    ...inspectorState,
    open: false,
    sdkSessionId: '',
    terminal: null,
    fitAddon: null,
    plainOutput: null,
    usesPlainOutput: false,
    lastResizeCols: null,
    lastResizeRows: null,
  };
  setStatus('');
  const sessionEl = document.getElementById('tmux-inspector-session');
  if (sessionEl) sessionEl.textContent = '';
  hideModal();
}

async function attachTmuxInspector(sessionId) {
  const socket = getSocket();
  if (!socket) throw new Error('Socket connection unavailable');
  inspectorState.socket = socket;
  ensureSocketListeners(socket);

  const payload = await new Promise((resolve, reject) => {
    socket.timeout(6000).emit('tmux_inspector_open', { sdkSessionId: sessionId }, (error, response) => {
      if (error) {
        reject(new Error('Timed out while opening tmux inspector'));
        return;
      }
      resolve(response || null);
    });
  });
  if (!payload?.ok) {
    throw new Error(String(payload?.reason || payload?.code || 'Unable to open tmux inspector'));
  }
  return payload;
}

function sendTmuxResize(cols, rows) {
  const socket = inspectorState.socket || getSocket();
  const sdkSessionId = String(inspectorState.sdkSessionId || '').trim();
  if (!socket || !sdkSessionId) return;
  const nextCols = Math.trunc(Number(cols));
  const nextRows = Math.trunc(Number(rows));
  if (!Number.isFinite(nextCols) || !Number.isFinite(nextRows)) return;
  if (nextCols < 80 || nextRows < 24) return;
  if (inspectorState.lastResizeCols === nextCols && inspectorState.lastResizeRows === nextRows) return;
  inspectorState.lastResizeCols = nextCols;
  inspectorState.lastResizeRows = nextRows;
  try {
    socket.emit('tmux_inspector_resize', {
      sdkSessionId,
      cols: nextCols,
      rows: nextRows,
    });
  } catch {}
}

function scheduleTmuxResizeSync() {
  if (!inspectorState.open || inspectorState.usesPlainOutput) return;
  const cols = Number(inspectorState.terminal?.cols || 0);
  const rows = Number(inspectorState.terminal?.rows || 0);
  if (!Number.isFinite(cols) || !Number.isFinite(rows) || cols <= 0 || rows <= 0) return;
  if (resizeDebounceTimer) clearTimeout(resizeDebounceTimer);
  resizeDebounceTimer = setTimeout(() => {
    resizeDebounceTimer = null;
    sendTmuxResize(cols, rows);
  }, 90);
}

async function openTmuxInspector() {
  const sdkSessionId = resolveCurrentSessionId();
  if (!sdkSessionId) {
    showTransientRelayNotice('Select a conversation with a bound SDK session first.');
    return;
  }
  closeTmuxInspector({ notifyServer: true });
  showModal();
  setStatus('Connecting…', false);
  const sessionEl = document.getElementById('tmux-inspector-session');
  if (sessionEl) sessionEl.textContent = sdkSessionId;
  const mount = document.getElementById('tmux-inspector-term');
  if (!mount) throw new Error('Terminal container missing');
  mount.innerHTML = '';
  const TerminalCtor = resolveTerminalRuntime();
  if (!TerminalCtor) {
    // Warm up renderer loading in the background without blocking first paint/connect.
    void ensureTerminalRuntimeLoaded();
  }
  if (TerminalCtor) {
    const terminal = new TerminalCtor({
      convertEol: false,
      disableStdin: true,
      cursorBlink: false,
      scrollback: 8000,
    });
    const FitAddonCtor = window?.FitAddon?.FitAddon;
    const fitAddon = typeof FitAddonCtor === 'function' ? new FitAddonCtor() : null;
    if (fitAddon) terminal.loadAddon(fitAddon);
    terminal.open(mount);
    inspectorState.terminal = terminal;
    inspectorState.fitAddon = fitAddon;
    inspectorState.plainOutput = null;
    inspectorState.usesPlainOutput = false;
  } else {
    const plain = document.createElement('pre');
    plain.className = 'tmux-inspector-plain-output';
    plain.setAttribute('aria-label', 'tmux console stream');
    mount.appendChild(plain);
    inspectorState.terminal = null;
    inspectorState.fitAddon = null;
    inspectorState.plainOutput = plain;
    inspectorState.usesPlainOutput = true;
  }
  inspectorState.open = true;
  inspectorState.sdkSessionId = sdkSessionId;
  fitTerminal();

  const attached = await attachTmuxInspector(sdkSessionId);
  const snapshot = String(attached?.snapshot || '');
  if (snapshot) {
    if (inspectorState.usesPlainOutput && inspectorState.plainOutput) {
      inspectorState.plainOutput.textContent = stripAnsiControlCodes(snapshot);
      inspectorState.plainOutput.scrollTop = inspectorState.plainOutput.scrollHeight;
    } else {
      inspectorState.terminal?.write(snapshot);
    }
  }
  setStatus(
    inspectorState.usesPlainOutput
      ? 'Read-only stream attached (plain renderer fallback)'
      : 'Read-only stream attached',
    false,
  );
  fitTerminal();
  scheduleTmuxResizeSync();
}

function bindCloseControls() {
  const closeBtn = document.getElementById('tmux-inspector-close');
  const modal = document.getElementById('tmux-inspector-modal');
  if (closeBtn && closeBtn.dataset.bound !== '1') {
    closeBtn.dataset.bound = '1';
    closeBtn.addEventListener('click', () => closeTmuxInspector({ notifyServer: true }));
  }
  if (modal && modal.dataset.bound !== '1') {
    modal.dataset.bound = '1';
    modal.addEventListener('click', (event) => {
      const dialog = modal.querySelector('.tmux-inspector-dialog');
      if (!dialog || dialog.contains(event.target)) return;
      closeTmuxInspector({ notifyServer: true });
    });
  }
  if (!window.__tmuxInspectorResizeBound) {
    window.__tmuxInspectorResizeBound = true;
    window.addEventListener('resize', () => {
      if (!inspectorState.open) return;
      fitTerminal();
    });
  }
}

export function initTmuxInspectorView({
  bindMenuAction,
  lockChatActionsMenuShield,
  closeChatActionsMenu,
} = {}) {
  bindCloseControls();
  const menuBtn = document.getElementById('chat-menu-inspect-tmux');
  if (!menuBtn || typeof bindMenuAction !== 'function') return;
  bindMenuAction(menuBtn, (event) => {
    event.preventDefault();
    event.stopPropagation();
    lockChatActionsMenuShield?.(350);
    closeChatActionsMenu?.();
    openTmuxInspector().catch((error) => {
      setStatus(String(error?.message || 'Failed to open tmux inspector'), true);
      showTransientRelayNotice(String(error?.message || 'Failed to open tmux inspector'));
    });
  });
}

export function closeTmuxInspectorView() {
  closeTmuxInspector({ notifyServer: true });
}
