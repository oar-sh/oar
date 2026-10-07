/**
 * The terminal side of `oar`: line prompts and the menu. Everything reads
 * from and writes to the stream pair it is given, so tests drive it with
 * fake streams.
 */

import readline from 'node:readline';

/** Ctrl+C (or a closed input) in a prompt or in the menu; `oar` exits 130 on it, without a message. */
export class PromptAborted extends Error {
  constructor() {
    super('Aborted');
    this.code = 'OAR_PROMPT_ABORTED';
  }
}

export function askLine(question, { input = process.stdin, output = process.stdout } = {}) {
  return new Promise((resolve, reject) => {
    let rl;
    try {
      rl = readline.createInterface({ input, output, terminal: Boolean(input.isTTY) });
    } catch {
      // A terminal that refuses raw mode still reads whole lines.
      rl = readline.createInterface({ input, output, terminal: false });
    }
    let settled = false;
    const abort = () => {
      if (settled) return;
      settled = true;
      rl.close();
      output.write('\n');
      reject(new PromptAborted());
    };
    rl.once('SIGINT', abort);
    rl.once('close', abort);
    rl.question(question, (answer) => {
      settled = true;
      rl.close();
      resolve(String(answer).trim());
    });
  });
}

export async function askYesNo(question, { defaultYes = false, input, output } = {}) {
  const answer = (await askLine(`${question} ${defaultYes ? '[Y/n]' : '[y/N]'} `, { input, output })).toLowerCase();
  return answer ? answer === 'y' || answer === 'yes' : defaultYes;
}

export function createPrompter({ input = process.stdin, output = process.stdout } = {}) {
  return {
    line: (question) => askLine(question, { input, output }),
    yesNo: (question, options = {}) => askYesNo(question, { ...options, input, output }),
  };
}

export const MENU_ENTRIES = Object.freeze([
  { id: 'start', label: 'Start' },
  { id: 'stop', label: 'Stop' },
  { id: 'restart', label: 'Restart' },
  { id: 'url', label: 'Show URL and QR code' },
  { id: 'setup', label: 'Settings' },
  { id: 'service', label: 'Install or remove the service' },
  { id: 'update', label: 'Update' },
  { id: 'doctor', label: 'Doctor' },
  { id: 'copilot', label: 'Copilot session' },
  { id: 'quit', label: 'Quit' },
]);

const RELAY_TEXT = {
  running: 'relay running',
  stopped: 'relay stopped',
  taken: 'relay not reachable (its port is held by another program, or by a relay with other settings)',
  unconfigured: 'not set up yet (choose Settings)',
};
const SERVICE_TEXT = {
  active: 'installed, running',
  installed: 'installed',
  none: 'not installed',
  unavailable: 'not available here',
};

export function menuUsesColor({ env = process.env, output = process.stdout } = {}) {
  return Boolean(output?.isTTY) && !String(env?.NO_COLOR || '');
}

/** The menu as lines of text: the status header, then the entries, the selected one marked. */
export function renderMenu({ status = {}, selected = 0, color = false } = {}) {
  const paint = (code, text) => (color ? `\x1b[${code}m${text}\x1b[0m` : text);
  const relay = RELAY_TEXT[status.relay] || RELAY_TEXT.stopped;
  const lines = [
    `${paint(1, `OAR ${status.version || ''}`.trim())} · ${paint(status.relay === 'running' ? 32 : 31, relay)}`,
  ];
  if (status.url) lines.push(`  URL      ${status.url}`);
  if (status.port) lines.push(`  Port     ${status.port}`);
  if (status.access) lines.push(`  Access   ${status.access === 'lan' ? 'LAN' : 'this machine only'}`);
  if (SERVICE_TEXT[status.service]) lines.push(`  Service  ${SERVICE_TEXT[status.service]}`);
  for (const warning of status.warnings || []) lines.push(paint(33, `  ! ${warning}`));
  lines.push('');
  MENU_ENTRIES.forEach((entry, index) => {
    const key = entry.id === 'quit' ? 'q' : String(index + 1);
    const text = `${index === selected ? '>' : ' '} ${key}  ${entry.label}`;
    lines.push(index === selected ? paint(7, text) : text);
  });
  lines.push('', 'Arrow keys and Enter, or a digit, to choose; q to quit.');
  return lines;
}

/** One chunk of raw input as a menu key: 'up', 'down', 'enter', 'quit', 'interrupt', an entry index, or null. */
export function readMenuKey(chunk) {
  const key = String(chunk);
  if (key === '\x03' || key === '\x04') return 'interrupt';
  if (key === '\x1b[A' || key === '\x1bOA' || key === 'k') return 'up';
  if (key === '\x1b[B' || key === '\x1bOB' || key === 'j') return 'down';
  if (key === '\r' || key === '\n') return 'enter';
  if (key === 'q' || key === 'Q') return 'quit';
  if (/^[1-9]$/.test(key)) return Number(key) - 1;
  return null;
}

/** Reads raw key presses until `onKey` returns a value; the terminal is back in line mode on every way out. */
function readKeys({ input, onKey }) {
  return new Promise((resolve, reject) => {
    const finish = (settle, value) => {
      input.removeListener('data', onData);
      input.removeListener('end', onEnd);
      try { input.setRawMode(false); } catch {}
      input.pause();
      settle(value);
    };
    const onEnd = () => finish(reject, new PromptAborted());
    const onData = (chunk) => {
      let result;
      try { result = onKey(readMenuKey(chunk)); } catch (error) { finish(reject, error); return; }
      if (result !== undefined) finish(resolve, result);
    };
    input.on('data', onData);
    input.once('end', onEnd);
    try {
      input.setRawMode(true);
      input.resume();
    } catch (error) {
      finish(reject, error);
    }
  });
}

/**
 * Runs the menu until Quit or Ctrl+C. `loadStatus()` returns the header's
 * status before each drawing; `actions[id](status)` runs an entry and may
 * return `{ exit: true }` to leave the menu. An input without raw mode gets
 * the same list with a numbered prompt.
 */
export async function runMenu({
  input = process.stdin,
  output = process.stdout,
  env = process.env,
  loadStatus = async () => ({}),
  actions = {},
} = {}) {
  const color = menuUsesColor({ env, output });
  let rawMode = typeof input.setRawMode === 'function';
  let selected = 0;
  const draw = (status) => {
    output.write(`${output.isTTY ? '\x1b[2J\x1b[H' : ''}${renderMenu({ status, selected, color }).join('\n')}\n`);
  };
  const pickByKey = (status) => readKeys({
    input,
    onKey: (key) => {
      if (key === 'interrupt') throw new PromptAborted();
      if (key === 'quit') return MENU_ENTRIES.length - 1;
      if (key === 'enter') return selected;
      if (typeof key === 'number') {
        selected = key;
        return selected;
      }
      if (key === 'up' || key === 'down') {
        selected = (selected + (key === 'up' ? MENU_ENTRIES.length - 1 : 1)) % MENU_ENTRIES.length;
        draw(status);
      }
      return undefined;
    },
  });
  const pickByNumber = async () => {
    for (;;) {
      const answer = (await askLine('Choose (1-9, q): ', { input, output })).toLowerCase();
      if (answer === 'q') return MENU_ENTRIES.length - 1;
      if (/^[1-9]$/.test(answer)) return Number(answer) - 1;
    }
  };

  try {
    for (;;) {
      const status = await loadStatus();
      draw(status);
      let choice;
      try {
        choice = rawMode ? await pickByKey(status) : await pickByNumber();
      } catch (error) {
        if (error instanceof PromptAborted || !rawMode) throw error;
        // The terminal refused raw mode.
        rawMode = false;
        choice = await pickByNumber();
      }
      selected = choice;
      const entry = MENU_ENTRIES[choice];
      if (entry.id === 'quit') return { code: 0, reason: 'menu-quit' };
      output.write('\n');
      let result = null;
      try {
        result = await actions[entry.id]?.(status);
      } catch (error) {
        // Ctrl+C inside an entry (a setup question) leaves that entry, not
        // the menu.
        if (error instanceof PromptAborted) {
          output.write('\n');
          continue;
        }
        output.write(`[oar] ${error?.message || error}\n`);
      }
      if (result?.exit) return { code: result.code ?? 0, reason: 'menu-exit' };
      output.write('\n');
      if (rawMode) {
        output.write('Press a key to go back to the menu. ');
        await readKeys({
          input,
          onKey: (key) => {
            if (key === 'interrupt') throw new PromptAborted();
            return true;
          },
        });
      } else {
        await askLine('Press Enter to go back to the menu. ', { input, output });
      }
    }
  } catch (error) {
    if (!(error instanceof PromptAborted)) throw error;
    output.write('\n');
    return { code: 130, reason: 'interrupted' };
  }
}
